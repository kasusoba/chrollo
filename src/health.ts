import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	type Client,
} from "discord.js";
import { getQueueSummary, retryQueued } from "./autoUpload.js";
import { oauth2Client } from "./googleClient.js";
import { describeError, getAlbum, getAuthUrl, isAuthError } from "./utils.js";

// Background health monitor. Checks Google reachability, auth and the album on
// a timer, and DMs the owner only when the overall state changes, so problems
// show up before someone posts a photo.

const INTERVAL_MS =
	(Number(process.env.HEALTH_CHECK_INTERVAL_MINUTES) || 10) * 60_000;
// After a bad check, look again soon so a one-off blip doesn't trigger a DM.
const RECHECK_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

export type CheckState = "ok" | "fail" | "skipped";

export interface Check {
	state: CheckState;
	detail: string;
}

export interface HealthReport {
	checkedAt: number;
	google: Check;
	auth: Check;
	album: Check;
}

interface UploadEvent {
	at: number;
	count?: number;
	error?: string;
}

let lastReport: HealthReport | null = null;
let lastUpload: UploadEvent | null = null;
let lastUploadError: UploadEvent | null = null;
// Problem summary we last told the owner about ("" = all good).
let notifiedProblems: string | null = null;
let pendingProblems: string | null = null;
let timer: NodeJS.Timeout | null = null;
let client: Client | null = null;
let running = false;
let rerun = false;

export function recordUploadSuccess(count: number) {
	lastUpload = { at: Date.now(), count };
}

export function recordUploadFailure(error: string) {
	lastUploadError = { at: Date.now(), error };
}

export function getHealthState() {
	return { lastReport, lastUpload, lastUploadError };
}

export async function runHealthCheck(): Promise<HealthReport> {
	const report: HealthReport = {
		checkedAt: Date.now(),
		google: { state: "skipped", detail: "" },
		auth: { state: "skipped", detail: "" },
		album: { state: "skipped", detail: "" },
	};

	if (!oauth2Client.credentials?.refresh_token) {
		report.auth = { state: "fail", detail: "not logged in" };
		report.album = { state: "skipped", detail: "needs auth" };
		return report;
	}

	const album = getAlbum();
	// Fetching the album also refreshes the access token, so one request
	// covers reachability, auth and the album. Without an album, list instead.
	const url = album?.id
		? `https://photoslibrary.googleapis.com/v1/albums/${album.id}`
		: "https://photoslibrary.googleapis.com/v1/albums?pageSize=1";

	const started = Date.now();
	try {
		const response = await oauth2Client.request<{
			title?: string;
			mediaItemsCount?: string;
		}>({ url, method: "GET", timeout: REQUEST_TIMEOUT_MS });
		const ms = Date.now() - started;

		report.google = { state: "ok", detail: `reachable (${ms}ms)` };
		report.auth = { state: "ok", detail: "OK" };
		if (album?.id) {
			const items = response.data.mediaItemsCount ?? "0";
			report.album = {
				state: "ok",
				detail: `${response.data.title ?? album.title} (${items} items)`,
			};
		} else {
			report.album = { state: "fail", detail: "none selected, use /album" };
		}
	} catch (error) {
		const status = (error as { response?: { status?: number } })?.response
			?.status;
		const reason = describeError(error);

		if (isAuthError(error)) {
			report.google = { state: "ok", detail: "reachable" };
			report.auth = { state: "fail", detail: reason };
			report.album = { state: "skipped", detail: "needs auth" };
		} else if (album?.id && (status === 404 || status === 400)) {
			report.google = { state: "ok", detail: "reachable" };
			report.auth = { state: "ok", detail: "OK" };
			report.album = {
				state: "fail",
				detail: `"${album.title}" not found on Google Photos (${reason})`,
			};
		} else if (status && status < 500) {
			// Google answered, but with an error we don't classify (e.g. 403 scope).
			report.google = { state: "ok", detail: "reachable" };
			report.auth = { state: "fail", detail: reason };
			report.album = { state: "skipped", detail: "needs auth" };
		} else {
			report.google = { state: "fail", detail: `unreachable (${reason})` };
			report.auth = { state: "skipped", detail: "Google unreachable" };
			report.album = { state: "skipped", detail: "Google unreachable" };
		}
	}

	return report;
}

function problemsOf(report: HealthReport): string {
	const problems: string[] = [];
	if (report.google.state === "fail")
		problems.push(`Google: ${report.google.detail}`);
	if (report.auth.state === "fail")
		problems.push(`Auth: ${report.auth.detail}`);
	if (report.album.state === "fail")
		problems.push(`Album: ${report.album.detail}`);
	return problems.join("\n");
}

/** One-tap fixes for the owner, shown under the alert DM. */
export function ownerActionRows(
	report: HealthReport,
): ActionRowBuilder<ButtonBuilder>[] {
	const buttons: ButtonBuilder[] = [];

	if (report.auth.state === "fail") {
		buttons.push(
			new ButtonBuilder()
				.setStyle(ButtonStyle.Link)
				.setLabel("Log in to Google")
				.setURL(getAuthUrl()),
		);
	}
	if (report.album.state === "fail") {
		const album = getAlbum();
		if (album?.title) {
			buttons.push(
				new ButtonBuilder()
					.setCustomId(OWNER_BUTTON.recreateAlbum)
					.setStyle(ButtonStyle.Primary)
					.setLabel(`Recreate "${album.title}"`.slice(0, 80)),
			);
		}
		buttons.push(
			new ButtonBuilder()
				.setCustomId(OWNER_BUTTON.pickAlbum)
				.setStyle(ButtonStyle.Secondary)
				.setLabel(album?.title ? "Choose another album" : "Choose album"),
		);
	}
	buttons.push(
		new ButtonBuilder()
			.setCustomId(OWNER_BUTTON.status)
			.setStyle(ButtonStyle.Secondary)
			.setLabel("Check again"),
	);

	return [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)];
}

export const OWNER_BUTTON = {
	recreateAlbum: "owner:album:recreate",
	pickAlbum: "owner:album:pick",
	status: "owner:status",
} as const;

async function notifyOwner(
	content: string,
	components: ActionRowBuilder<ButtonBuilder>[] = [],
) {
	const ownerId = process.env.DISCORD_OWNER_ID;
	if (!ownerId || !client) return;
	try {
		const owner = await client.users.fetch(ownerId);
		await owner.send({ content, components });
	} catch (error) {
		console.error("[HEALTH] Failed to DM owner:", error);
	}
}

function queueLine(): string {
	const { messages, files } = getQueueSummary();
	return files
		? `\n${files} file(s) from ${messages} message(s) are waiting and will upload once this is fixed.`
		: "";
}

async function tick() {
	timer = null;
	if (running) {
		rerun = true;
		return;
	}
	running = true;
	try {
		await check();
	} catch (error) {
		console.error("[HEALTH] Check crashed:", error);
		schedule(INTERVAL_MS);
	} finally {
		running = false;
		if (rerun) {
			rerun = false;
			schedule(1_000);
		}
	}
}

async function check() {
	const report = await runHealthCheck();
	lastReport = report;
	const problems = problemsOf(report);

	if (problems) console.warn(`[HEALTH] Problems:\n${problems}`);
	else console.log("[HEALTH] OK");

	// Healthy: upload anything that was waiting.
	let retried = 0;
	if (!problems && client) retried = await retryQueued(client);

	if (problems === notifiedProblems) {
		pendingProblems = null;
	} else if (notifiedProblems === null && !problems) {
		// First check after boot and all good: nothing to report.
		notifiedProblems = "";
	} else if (problems && pendingProblems !== problems) {
		// New problem: confirm it on a quick recheck before alerting.
		pendingProblems = problems;
		schedule(RECHECK_MS);
		return;
	} else {
		pendingProblems = null;
		notifiedProblems = problems;
		if (problems) {
			await notifyOwner(
				`⚠️ Chrollo has a problem, photos can't upload right now.\n${problems}${queueLine()}`,
				ownerActionRows(report),
			);
		} else {
			const done = retried ? ` Uploaded ${retried} waiting file(s).` : "";
			await notifyOwner(`✅ Chrollo is healthy again.${done}`);
		}
	}

	// While files wait, check more often so they go up soon after recovery.
	const waiting = getQueueSummary().files > 0;
	schedule(problems ? RECHECK_MS * 5 : waiting ? RECHECK_MS * 2 : INTERVAL_MS);
}

function schedule(ms: number) {
	if (timer) clearTimeout(timer);
	timer = setTimeout(tick, ms);
}

export function startHealthMonitor(discordClient: Client) {
	client = discordClient;
	if (!process.env.DISCORD_OWNER_ID) {
		console.warn(
			"[HEALTH] DISCORD_OWNER_ID not set, problems are only logged.",
		);
	}
	schedule(0);
}

/** Run a check soon, e.g. right after the album or login changed. */
export function triggerHealthCheck() {
	if (client) schedule(1_000);
}

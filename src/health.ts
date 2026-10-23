import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	type Client,
} from "discord.js";
import { getQueueSummary, retryQueued } from "./autoUpload.js";
import { oauth2Client } from "./googleClient.js";
import {
	type Album,
	describeError,
	getAlbum,
	getAuthUrl,
	getLinkedChannels,
	isAuthError,
	type LinkedChannel,
} from "./utils.js";

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

export interface AlbumCheck extends Check {
	channelId: string;
	label: string;
}

export interface HealthReport {
	checkedAt: number;
	google: Check;
	auth: Check;
	/** One per upload channel. */
	albums: AlbumCheck[];
}

/** The album check for one channel. */
export function albumCheckFor(
	report: HealthReport,
	channelId: string,
): AlbumCheck | undefined {
	return report.albums.find((a) => a.channelId === channelId);
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
		albums: [],
	};
	const linked = getLinkedChannels();
	report.albums = linked.map((c) => ({
		channelId: c.channelId,
		label: c.label,
		state: "skipped" as CheckState,
		detail: "",
	}));
	const skipRest = (detail: string) => {
		for (const a of report.albums) {
			if (a.state === "skipped") a.detail = detail;
		}
	};

	if (!oauth2Client.credentials?.refresh_token) {
		report.auth = { state: "fail", detail: "not logged in" };
		skipRest("needs auth");
		return report;
	}

	// Fetching an album also refreshes the access token, so these requests
	// cover reachability and auth too.
	const requests = report.albums.map((check, i) => ({
		check,
		album: (linked[i] as LinkedChannel).album,
	}));
	// Nothing linked: list albums just to check Google and auth.
	const targets: { check?: AlbumCheck; url: string; album?: Album }[] =
		requests.length
			? requests.map((r) => ({
					check: r.check,
					album: r.album,
					url: `https://photoslibrary.googleapis.com/v1/albums/${r.album.id}`,
				}))
			: [{ url: "https://photoslibrary.googleapis.com/v1/albums?pageSize=1" }];

	for (const target of targets) {
		const started = Date.now();
		try {
			const response = await oauth2Client.request<{
				title?: string;
				mediaItemsCount?: string;
			}>({ url: target.url, method: "GET", timeout: REQUEST_TIMEOUT_MS });
			const ms = Date.now() - started;

			if (report.google.state !== "ok") {
				report.google = { state: "ok", detail: `reachable (${ms}ms)` };
			}
			report.auth = { state: "ok", detail: "OK" };
			if (target.check && target.album) {
				const items = response.data.mediaItemsCount ?? "0";
				target.check.state = "ok";
				target.check.detail = `${response.data.title ?? target.album.title} (${items} items)`;
			}
		} catch (error) {
			const status = (error as { response?: { status?: number } })?.response
				?.status;
			const reason = describeError(error);

			if (target.check && target.album && (status === 404 || status === 400)) {
				if (report.google.state !== "ok") {
					report.google = { state: "ok", detail: "reachable" };
				}
				report.auth = { state: "ok", detail: "OK" };
				target.check.state = "fail";
				target.check.detail = `"${target.album.title}" not found on Google Photos (${reason})`;
			} else if (isAuthError(error) || (status && status < 500)) {
				// 401/invalid_grant, or another 4xx such as a missing scope.
				report.google = { state: "ok", detail: "reachable" };
				report.auth = { state: "fail", detail: reason };
				skipRest("needs auth");
				return report;
			} else {
				report.google = { state: "fail", detail: `unreachable (${reason})` };
				report.auth = { state: "skipped", detail: "Google unreachable" };
				skipRest("Google unreachable");
				return report;
			}
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
	for (const a of report.albums) {
		if (a.state === "fail") problems.push(`Album #${a.label}: ${a.detail}`);
	}
	return problems.join("\n");
}

export const OWNER_BUTTON = {
	/** Followed by the channel ID. */
	recreateAlbum: "owner:album:recreate:",
	/** Followed by the channel ID. */
	pickAlbum: "owner:album:pick:",
	status: "owner:status",
} as const;

/** One-tap fixes for the owner, shown under the alert DM. */
export function ownerActionRows(
	report: HealthReport,
): ActionRowBuilder<ButtonBuilder>[] {
	const rows: ActionRowBuilder<ButtonBuilder>[] = [];
	const row = (...buttons: ButtonBuilder[]) =>
		rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons));

	if (report.auth.state === "fail") {
		row(
			new ButtonBuilder()
				.setStyle(ButtonStyle.Link)
				.setLabel("Log in to Google")
				.setURL(getAuthUrl()),
		);
	}
	// Discord allows 5 rows: login, check again, and up to 3 album rows.
	for (const a of report.albums.filter((x) => x.state === "fail").slice(0, 3)) {
		const album = getAlbum(a.channelId);
		const buttons: ButtonBuilder[] = [];
		if (album?.title) {
			buttons.push(
				new ButtonBuilder()
					.setCustomId(OWNER_BUTTON.recreateAlbum + a.channelId)
					.setStyle(ButtonStyle.Primary)
					.setLabel(`Recreate "${album.title}" for #${a.label}`.slice(0, 80)),
			);
		}
		buttons.push(
			new ButtonBuilder()
				.setCustomId(OWNER_BUTTON.pickAlbum + a.channelId)
				.setStyle(ButtonStyle.Secondary)
				.setLabel(`Choose another album for #${a.label}`.slice(0, 80)),
		);
		row(...buttons);
	}
	row(
		new ButtonBuilder()
			.setCustomId(OWNER_BUTTON.status)
			.setStyle(ButtonStyle.Secondary)
			.setLabel("Check again"),
	);
	return rows;
}

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

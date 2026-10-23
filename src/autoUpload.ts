import fs from "node:fs";
import path from "node:path";
import {
	type Attachment,
	type Client,
	type Message,
	MessageFlags,
} from "discord.js";
import {
	recordUploadFailure,
	recordUploadSuccess,
	runHealthCheck,
	triggerHealthCheck,
} from "./health.js";
import {
	type FileFailure,
	getAlbum,
	getMessageAttachments,
	isMediaAttachment,
	OPERATING_CHANNEL_ID,
	uploadPhotos,
} from "./utils.js";

// Uploads photos posted in the channel. When Google, the login or the album is
// broken, files are saved to a queue on disk and retried automatically once the
// health check sees things working again. Members never have to post again.

const QUEUE_PATH = path.join(process.cwd(), "data", "queue.json");

const WAITING = "⏳";
const DONE = "✅";

type BlockedReason = "auth" | "album" | "network";

interface QueueEntry {
	messageId: string;
	/** Attachments still waiting to upload. */
	attachmentIds: string[];
	/** The bot's reply to the message, edited when the retry finishes. */
	replyId?: string | undefined;
	/** Files that failed for good, kept so the final reply still lists them. */
	notes: string[];
	uploadedCount: number;
	queuedAt: number;
	lastError: string;
}

let queue: QueueEntry[] = loadQueue();
let retrying = false;

function loadQueue(): QueueEntry[] {
	try {
		return JSON.parse(fs.readFileSync(QUEUE_PATH, "utf-8"));
	} catch {
		return [];
	}
}

function saveQueue() {
	try {
		fs.mkdirSync(path.dirname(QUEUE_PATH), { recursive: true });
		const tmp = `${QUEUE_PATH}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(queue, null, 2));
		fs.renameSync(tmp, QUEUE_PATH);
	} catch (error) {
		console.error("[QUEUE] Failed to save queue:", error);
	}
}

export function getQueueSummary() {
	return {
		messages: queue.length,
		files: queue.reduce((sum, e) => sum + e.attachmentIds.length, 0),
		oldest: queue.length ? Math.min(...queue.map((e) => e.queuedAt)) : null,
	};
}

/** Called when a message was uploaded some other way (e.g. /upload). */
export function removeFromQueue(messageId: string) {
	const before = queue.length;
	queue = queue.filter((e) => e.messageId !== messageId);
	if (queue.length !== before) saveQueue();
}

function upsert(entry: QueueEntry) {
	queue = queue.filter((e) => e.messageId !== entry.messageId);
	queue.push(entry);
	saveQueue();
}

const blockedText: Record<BlockedReason, string> = {
	auth: "the bot needs to be reconnected to Google, the owner is being notified",
	album: "the album needs fixing, the owner is being notified",
	network: "Google Photos can't be reached right now",
};

/** Lines for files that failed for good, e.g. "❌ a.pdf: not a photo or video". */
function permanentLines(failures: FileFailure[]): string[] {
	return failures
		.filter((f) => !f.retryable)
		.map((f) => `❌ ${f.name}: ${f.reason}. Try posting it in another format.`);
}

async function react(message: Message, add?: string, remove?: string) {
	try {
		if (remove) {
			await message.reactions.cache
				.get(remove)
				?.users.remove(message.client.user.id);
		}
		if (add) await message.react(add);
	} catch (error) {
		console.warn("[UPLOAD] Couldn't update reaction:", error);
	}
}

/** Checks Google, auth and album. Returns the album, or why uploads are blocked. */
async function readiness(): Promise<
	{ albumId: string; title: string } | { blocked: BlockedReason }
> {
	const report = await runHealthCheck();
	if (report.google.state === "fail") return { blocked: "network" };
	if (report.auth.state === "fail") return { blocked: "auth" };
	const album = getAlbum();
	if (report.album.state !== "ok" || !album?.id) return { blocked: "album" };
	return { albumId: album.id, title: album.title };
}

function uploadOptions(message: Message) {
	return {
		uploaderName: message.author.username,
		uploaderDisplayName:
			message.member?.displayName ??
			message.author.displayName ??
			message.author.username,
		uploadTimestamp: message.createdTimestamp,
		messageId: message.id,
	};
}

/** Handles a new message in the channel. */
export async function autoUpload(message: Message) {
	const all = getMessageAttachments(message);
	const media = all.filter(isMediaAttachment);
	// Non-media files (PDFs, text) are left alone. Only mention them when the
	// message also had photos, so the summary is complete.
	if (media.length === 0) return;
	const skipped = all
		.filter((a) => !isMediaAttachment(a))
		.map((a) => `➖ ${a.name}: skipped, not a photo or video.`);

	const ready = await readiness();

	if ("blocked" in ready) {
		recordUploadFailure(`blocked: ${ready.blocked}`);
		// Queue first, so the files are saved even if replying fails.
		const entry: QueueEntry = {
			messageId: message.id,
			attachmentIds: media.map((a) => a.id),
			notes: skipped,
			uploadedCount: 0,
			queuedAt: Date.now(),
			lastError: ready.blocked,
		};
		upsert(entry);
		await react(message, WAITING);
		entry.replyId = await quietReply(
			message,
			[
				`${WAITING} Couldn't upload yet: ${blockedText[ready.blocked]}.`,
				`Saved **${media.length}** file(s), they'll upload automatically. Nothing to do on your side.`,
				...skipped,
			].join("\n"),
		);
		saveQueue();
		// Gets the owner DM going (after its usual one-minute confirmation).
		if (ready.blocked !== "network") triggerHealthCheck();
		return;
	}

	const result = await uploadPhotos(
		media,
		ready.albumId,
		uploadOptions(message),
	);
	const retry = result.failed.filter((f) => f.retryable);
	const permanent = permanentLines(result.failed);
	const notes = [...permanent, ...skipped];

	if (result.numOfUploaded) recordUploadSuccess(result.numOfUploaded);
	if (result.failed.length) {
		recordUploadFailure(
			result.failed.map((f) => `${f.name}: ${f.reason}`).join("; "),
		);
	}

	const lines: string[] = [];
	if (result.failed.length === 0) {
		lines.push(
			`Successfully uploaded **${result.numOfUploaded}** images to Google Photos album **${ready.title}**!`,
		);
	} else {
		lines.push(
			`Uploaded **${result.numOfUploaded}** of ${media.length} file(s) to **${ready.title}**.`,
		);
	}
	if (retry.length) {
		lines.push(
			`${WAITING} ${retry.map((f) => f.name).join(", ")}: will retry automatically, nothing to do on your side.`,
		);
	}
	lines.push(...notes);

	const entry: QueueEntry | null = retry.length
		? {
				messageId: message.id,
				attachmentIds: retry.map((f) => f.attachmentId),
				notes,
				uploadedCount: result.numOfUploaded,
				queuedAt: Date.now(),
				lastError: retry.map((f) => f.reason).join("; "),
			}
		: null;
	if (entry) {
		upsert(entry);
		await react(message, WAITING);
	}

	// Ping the poster only when they need to do something (re-post a file).
	const replyId = await quietReply(
		message,
		lines.join("\n"),
		permanent.length > 0,
	);
	if (entry) {
		entry.replyId = replyId;
		saveQueue();
	}
}

async function quietReply(
	message: Message,
	content: string,
	ping = false,
): Promise<string | undefined> {
	try {
		const reply = await message.reply({
			content,
			...(ping
				? {}
				: {
						flags: MessageFlags.SuppressNotifications,
						allowedMentions: { repliedUser: false },
					}),
		});
		return reply.id;
	} catch (error) {
		console.error("[UPLOAD] Couldn't reply:", error);
		return undefined;
	}
}

/**
 * Retries queued messages. Called by the health check once everything is OK.
 * Returns how many files went up.
 */
export async function retryQueued(client: Client): Promise<number> {
	if (retrying || queue.length === 0) return 0;
	retrying = true;
	let uploaded = 0;

	try {
		const ready = await readiness();
		if ("blocked" in ready) return 0;

		const channel = await client.channels.fetch(OPERATING_CHANNEL_ID);
		if (!channel?.isTextBased()) return 0;

		for (const entry of [...queue]) {
			let message: Message;
			try {
				message = await channel.messages.fetch(entry.messageId);
			} catch {
				console.log(`[QUEUE] Message ${entry.messageId} is gone, dropping it.`);
				removeFromQueue(entry.messageId);
				continue;
			}

			const waiting = new Set(entry.attachmentIds);
			const attachments: Attachment[] = getMessageAttachments(message).filter(
				(a) => waiting.has(a.id),
			);
			if (attachments.length === 0) {
				removeFromQueue(entry.messageId);
				continue;
			}

			const result = await uploadPhotos(
				attachments,
				ready.albumId,
				uploadOptions(message),
			);
			uploaded += result.numOfUploaded;
			if (result.numOfUploaded) recordUploadSuccess(result.numOfUploaded);

			const retry = result.failed.filter((f) => f.retryable);
			const notes = [...entry.notes, ...permanentLines(result.failed)];
			const total = entry.uploadedCount + result.numOfUploaded;

			if (retry.length) {
				// Still failing: keep what's left and stop, Google is likely down again.
				upsert({
					...entry,
					attachmentIds: retry.map((f) => f.attachmentId),
					notes,
					uploadedCount: total,
					lastError: retry.map((f) => f.reason).join("; "),
				});
				recordUploadFailure(
					retry.map((f) => `${f.name}: ${f.reason}`).join("; "),
				);
				break;
			}

			removeFromQueue(entry.messageId);
			console.log(
				`[QUEUE] Uploaded ${result.numOfUploaded} file(s) from ${entry.messageId}.`,
			);

			const content = [
				`${DONE} Uploaded **${total}** file(s) to **${ready.title}** (after a retry).`,
				...notes,
			].join("\n");
			try {
				if (!entry.replyId) throw new Error("no reply");
				const reply = await channel.messages.fetch(entry.replyId);
				await reply.edit({ content });
			} catch {
				await quietReply(message, content);
			}
			await react(message, DONE, WAITING);
		}
	} catch (error) {
		console.error("[QUEUE] Retry failed:", error);
	} finally {
		retrying = false;
	}

	return uploaded;
}

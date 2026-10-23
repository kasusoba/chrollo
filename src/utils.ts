import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Attachment, Message } from "discord.js";
import { exiftool } from "exiftool-vendored";
import { oauth2Client } from "./googleClient.js";

// The single server + channel the bot operates on (auto-uploads photos from).
export const OPERATING_GUILD_ID = "324920310459793410"; // dmc
export const OPERATING_CHANNEL_ID = "1046093481774424184"; // omoide

const ALBUM_FILE_NAME = "album.json";

export const ALBUM_PATH = path.join(process.cwd(), ALBUM_FILE_NAME);

export interface Album {
	id: string;
	title: string;
}

export interface GoogleAlbum {
	id: string;
	title: string;
	productUrl?: string;
	isWriteable?: boolean;
}

export interface GetAlbumsResponse {
	albums?: GoogleAlbum[];
	nextPageToken?: string;
}

interface UploadItem {
	description?: string;
	simpleMediaItem: {
		uploadToken: string;
		fileName: string;
	};
}

export interface UploadOptions {
	uploaderName: string;
	uploaderDisplayName: string;
	uploadTimestamp: number;
	messageId: string;
}

export interface SearchMediaItemsResponse {
	mediaItems?: {
		id: string;
		description?: string;
		baseUrl?: string;
		productUrl?: string;
		mimeType?: string;
		filename?: string;
		mediaMetadata?: {
			video?: {
				durationMillis?: string;
			};
		};
	}[];
	nextPageToken?: string;
}

// Tags descriptions with "| msg:123" or "| msg:123,456" (the latter when the
// exact same file was posted in more than one message) so the album (shared
// across machines) can answer dedup checks.
export const MESSAGE_ID_TAG_PATTERN = /\|\s*msg:([\d,]+)\s*$/;

function tagDescriptionWithMessageId(
	description: string,
	messageId: string,
): string {
	return `${description} | msg:${messageId}`;
}

export function tagDescriptionWithMessageIds(
	description: string,
	messageIds: string[],
): string {
	return `${description} | msg:${messageIds.join(",")}`;
}

// Forwarded messages carry attachments in messageSnapshots, not message.attachments.
export function getMessageAttachments(message: Message): Attachment[] {
	const own = Array.from(message.attachments.values());
	const forwarded = message.messageSnapshots.size
		? Array.from(message.messageSnapshots.values()).flatMap((snapshot) =>
				Array.from(snapshot.attachments.values()),
			)
		: [];
	return own.concat(forwarded);
}

export function hasUploadableAttachments(message: Message): boolean {
	return !message.author.bot && getMessageAttachments(message).length > 0;
}

// --- ERROR HANDLING HELPERS ---

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Builds the URL a user visits to (re-)authenticate the bot with Google.
 * Derived from GOOGLE_REDIRECT_URI (".../auth/callback" -> ".../auth").
 */
export function getAuthUrl(): string {
	const redirect = process.env.GOOGLE_REDIRECT_URI;
	if (redirect?.endsWith("/callback")) {
		return redirect.slice(0, -"/callback".length);
	}
	return "http://localhost:3000/auth";
}

/**
 * True when an error means the Google credentials are dead and the bot needs
 * to be re-authenticated (expired/revoked refresh token, or a 401).
 */
// biome-ignore lint/suspicious/noExplicitAny: error shape is untyped
export function isAuthError(error: any): boolean {
	const status = error?.response?.status;
	const googleError = error?.response?.data?.error;
	return (
		status === 401 ||
		googleError === "invalid_grant" ||
		googleError === "unauthorized_client"
	);
}

/**
 * Wraps an API request with retry logic based on Google Cloud API recommendations.
 * - 5xx: Exponential backoff (starting at 1s)
 * - 429: Wait 30s minimum
 * - Other 4xx: Fail immediately
 */
export async function requestWithRetry<T>(
	requestFn: () => Promise<T>,
	operationName = "API Request",
): Promise<T> {
	let attempt = 0;
	let delay = 1000; // Start with 1 second for 5xx errors
	const maxRetries = 5;

	while (true) {
		try {
			return await requestFn();
		} catch (error: any) {
			attempt++;
			const status = error.response?.status || error.code;

			// If we've maxed out retries, or if it's a non-retriable error (like 400, 401, 404)
			// Note: 429 and 5xx are the main targets for retry
			const isRetriable =
				status === 429 || (typeof status === "number" && status >= 500);

			if (attempt > maxRetries || !isRetriable) {
				throw error;
			}

			let waitTime = 0;

			if (status === 429) {
				console.warn(
					`[${operationName}] Hit Rate Limit (429). Waiting 30s before retry ${attempt}/${maxRetries}...`,
				);
				// Doc says: "For 429 errors, the client may retry with minimum 30s delay."
				waitTime = 30000 + Math.random() * 1000; // 30s + small jitter
			} else {
				// 5xx Errors
				console.warn(
					`[${operationName}] Server Error (${status}). Retrying in ${delay}ms (Attempt ${attempt}/${maxRetries})...`,
				);
				waitTime = delay;
				delay *= 2; // Exponential backoff: 1s -> 2s -> 4s -> 8s...
			}

			await sleep(waitTime);
		}
	}
}

// ------------------------------

export function getAlbum(): Album | null {
	if (fs.existsSync(ALBUM_PATH)) {
		const data = JSON.parse(fs.readFileSync(ALBUM_PATH, "utf-8"));
		console.log("[INTERACTION: Album] Loaded album from album.json");
		return data;
	} else {
		console.log("[INTERACTION: Album] No album found.");
		return null;
	}
}

export async function getValidatedAlbum() {
	const album = getAlbum();

	if (!album || !album.id) {
		throw new Error(
			"No album selected. Please select an album using /album before uploading.",
		);
	}

	try {
		// Wrapped in retry logic
		await requestWithRetry(
			() =>
				oauth2Client.request({
					url: `https://photoslibrary.googleapis.com/v1/albums/${album.id}`,
					method: "GET",
				}),
			"Get Album",
		);

		return album;
	} catch (error) {
		if (isAuthError(error)) {
			throw new Error(
				`Bot needs to re-authenticate with Google. Log in here: ${getAuthUrl()}`,
			);
		}
		const status = (error as any)?.response?.status;
		if (status === 404 || status === 400) {
			throw new Error(
				"The selected album does not exist on Google Photos. Please select a valid album using /album.",
			);
		}
		console.error("[Get Album] Album check failed:", error);
		throw new Error(
			`Couldn't reach Google Photos to check the album (${(error as any)?.code ?? status ?? "unknown error"}). Please try again in a bit.`,
		);
	}
}

const execFileAsync = promisify(execFile);

// Helper: Run FFmpeg specifically for video dates
async function modifyVideoDate(
	inputPath: string,
	outputPath: string,
	date: Date,
) {
	// Format date for FFmpeg: "YYYY-MM-DD HH:MM:SS"
	const dateStr = date.toISOString().replace("T", " ").split(".")[0];

	// Arguments matching your successful Python script
	const args = [
		"-i",
		inputPath,
		"-c",
		"copy", // Copy stream (fast)
		"-map_metadata",
		"0", // Keep other metadata
		"-metadata",
		`creation_time=${dateStr}`, // Inject date
		"-y", // Overwrite output
		outputPath,
	];

	await execFileAsync("ffmpeg", args);
}

/** A file failed to upload. `retryable` means trying again later may work. */
export class UploadFileError extends Error {
	constructor(
		message: string,
		readonly retryable: boolean,
	) {
		super(message);
	}
}

/**
 * Short, readable reason for a failed request, e.g. "HTTP 400: Invalid album
 * ID." or "ETIMEDOUT".
 */
// biome-ignore lint/suspicious/noExplicitAny: error shape is untyped
export function describeError(error: any): string {
	const status = error?.response?.status;
	const googleMessage =
		error?.response?.data?.error?.message ?? error?.response?.data?.error;
	if (status) {
		return typeof googleMessage === "string"
			? `HTTP ${status}: ${googleMessage}`
			: `HTTP ${status}`;
	}
	return error?.code ?? error?.message ?? "unknown error";
}

/** Google rejected the request itself (bad input), so retrying won't help. */
// biome-ignore lint/suspicious/noExplicitAny: error shape is untyped
function isPermanentRequestError(error: any): boolean {
	const status = error?.response?.status;
	return (
		typeof status === "number" &&
		status >= 400 &&
		status < 500 &&
		status !== 408 &&
		status !== 429 &&
		!isAuthError(error)
	);
}

const MEDIA_EXTENSIONS = new Set([
	".jpg",
	".jpeg",
	".png",
	".gif",
	".webp",
	".heic",
	".heif",
	".avif",
	".bmp",
	".tif",
	".tiff",
	".ico",
	".dng",
	".raw",
	".mp4",
	".mov",
	".mkv",
	".avi",
	".webm",
	".m4v",
	".3gp",
	".3g2",
	".mpg",
	".mpeg",
	".mts",
	".m2ts",
	".wmv",
]);

/** True for photos and videos, the only files Google Photos accepts. */
export function isMediaAttachment(attachment: Attachment): boolean {
	const type = attachment.contentType ?? "";
	if (type.startsWith("image/") || type.startsWith("video/")) return true;
	return MEDIA_EXTENSIONS.has(path.extname(attachment.name).toLowerCase());
}

/** Downloads, fixes the date, and uploads the bytes. Throws UploadFileError. */
export async function uploadBytesToGooglePhotos(
	attachment: Attachment,
	fallbackDate: Date,
): Promise<UploadItem> {
	console.log(`Processing ${attachment.name}...`);

	let arrayBuffer: ArrayBuffer;
	try {
		const response = await fetch(attachment.url);
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		arrayBuffer = await response.arrayBuffer();
	} catch (error) {
		// Retrying refetches the message, which also renews expired Discord links.
		throw new UploadFileError(
			`download from Discord failed (${describeError(error)})`,
			true,
		);
	}

	const tempDir = os.tmpdir();
	const baseName = `${Date.now()}_${attachment.name}`;
	const inputPath = path.join(tempDir, baseName);
	const outputPath = path.join(tempDir, `processed_${baseName}`);
	const cleanupFiles = [inputPath, outputPath, `${inputPath}_original`];

	const ext = path.extname(attachment.name).toLowerCase();
	const isVideo =
		attachment.contentType?.startsWith("video/") ||
		[".mp4", ".mov", ".mkv", ".avi", ".webm"].includes(ext);

	let finalBuffer: Buffer = Buffer.from(arrayBuffer);

	try {
		await fs.promises.writeFile(inputPath, finalBuffer);

		// Date fixing is best effort: if it fails, upload the original file.
		if (isVideo) {
			console.log("> Type: Video. Using FFmpeg...");
			try {
				await modifyVideoDate(inputPath, outputPath, fallbackDate);
				finalBuffer = await fs.promises.readFile(outputPath);
			} catch (e) {
				console.error("FFmpeg failed, uploading original:", e);
			}
		} else {
			console.log("> Type: Image. Using ExifTool...");
			try {
				const tags = await exiftool.read(inputPath);
				if (tags.DateTimeOriginal) {
					console.log("> Existing EXIF found. Skipping modification.");
				} else {
					await exiftool.write(inputPath, {
						DateTimeOriginal: fallbackDate.toISOString(),
						CreateDate: fallbackDate.toISOString(),
						ModifyDate: fallbackDate.toISOString(),
						AllDates: fallbackDate.toISOString(),
					});
					finalBuffer = await fs.promises.readFile(inputPath);
				}
			} catch (e) {
				console.error("ExifTool failed, uploading original:", e);
			}
		}
	} catch (error) {
		throw new UploadFileError(
			`couldn't process the file on the bot (${describeError(error)})`,
			true,
		);
	} finally {
		Promise.all(cleanupFiles.map((f) => fs.promises.unlink(f).catch(() => {})));
	}

	try {
		const uploadResponse = await requestWithRetry(
			() =>
				oauth2Client.request<string>({
					url: "https://photoslibrary.googleapis.com/v1/uploads",
					method: "POST",
					headers: {
						"Content-type": "application/octet-stream",
						"X-Goog-Upload-Protocol": "raw",
						"X-Goog-Upload-Content-Type":
							attachment.contentType || "application/octet-stream",
					},
					data: finalBuffer,
				}),
			"Upload Bytes",
		);

		return {
			simpleMediaItem: {
				uploadToken: uploadResponse.data,
				fileName: attachment.name,
			},
		};
	} catch (error) {
		console.error("Error uploading to Google Photos:", error);
		throw new UploadFileError(
			`Google Photos upload failed (${describeError(error)})`,
			!isPermanentRequestError(error),
		);
	}
}

// --- NEW UTILITIES ---

/**
 * Fetches ALL media item IDs from a specific album.
 * Handles pagination automatically.
 */
export async function getAllMediaItemsInAlbum(
	albumId: string,
): Promise<string[]> {
	const mediaItemIds: string[] = [];
	let nextPageToken: string | undefined;

	console.log(`[Album Purge] Fetching items for album ${albumId}...`);

	do {
		// eslint-disable-next-line no-await-in-loop
		const response = await requestWithRetry(
			() =>
				oauth2Client.request<SearchMediaItemsResponse>({
					url: "https://photoslibrary.googleapis.com/v1/mediaItems:search",
					method: "POST",
					data: {
						albumId: albumId,
						pageSize: "100", // Max allowed by API
						pageToken: nextPageToken,
					},
				}),
			"Search Media Items",
		);

		if (response.data.mediaItems) {
			const ids = response.data.mediaItems.map((item) => item.id);
			mediaItemIds.push(...ids);
		}

		nextPageToken = response.data.nextPageToken;
	} while (nextPageToken);

	console.log(`[Album Purge] Found ${mediaItemIds.length} total items.`);
	return mediaItemIds;
}

export async function getUploadedMessageIdsInAlbum(
	albumId: string,
): Promise<Set<string>> {
	const messageIds = new Set<string>();
	let nextPageToken: string | undefined;

	do {
		// eslint-disable-next-line no-await-in-loop
		const response = await requestWithRetry(
			() =>
				oauth2Client.request<SearchMediaItemsResponse>({
					url: "https://photoslibrary.googleapis.com/v1/mediaItems:search",
					method: "POST",
					data: {
						albumId: albumId,
						pageSize: "100",
						pageToken: nextPageToken,
					},
				}),
			"Search Media Items (dedup)",
		);

		for (const item of response.data.mediaItems ?? []) {
			const match = item.description?.match(MESSAGE_ID_TAG_PATTERN);
			const idsList = match?.[1];
			if (idsList) {
				for (const id of idsList.split(",")) {
					if (id) messageIds.add(id);
				}
			}
		}

		nextPageToken = response.data.nextPageToken;
	} while (nextPageToken);

	return messageIds;
}

/**
 * Removes media items from an album in batches of 50 (API limit).
 */
export async function batchRemoveMediaItems(
	albumId: string,
	mediaItemIds: string[],
) {
	// Chunk into arrays of 50
	const chunkSize = 50;
	const chunks = [];
	for (let i = 0; i < mediaItemIds.length; i += chunkSize) {
		chunks.push(mediaItemIds.slice(i, i + chunkSize));
	}

	console.log(
		`[Album Purge] Removing ${mediaItemIds.length} items in ${chunks.length} batches...`,
	);

	let removedCount = 0;

	for (const [index, chunk] of chunks.entries()) {
		try {
			// eslint-disable-next-line no-await-in-loop
			await requestWithRetry(
				() =>
					oauth2Client.request({
						url: `https://photoslibrary.googleapis.com/v1/albums/${albumId}:batchRemoveMediaItems`,
						method: "POST",
						headers: { "Content-type": "application/json" },
						data: {
							mediaItemIds: chunk,
						},
					}),
				"Batch Remove",
			);
			removedCount += chunk.length;
			console.log(
				`[Album Purge] Batch ${index + 1}/${chunks.length} successful.`,
			);
		} catch (error) {
			console.error(`[Album Purge] Failed batch ${index + 1}:`, error);
			// We throw here because partial success isn't supported well in the UI feedback
			throw error;
		}
	}

	return removedCount;
}

interface BatchCreateResponse {
	newMediaItemResults?: {
		uploadToken: string;
		status?: { code?: number; message?: string };
	}[];
}

/**
 * Adds uploaded bytes to the library (and album). Throws if the whole request
 * fails. Returns an error message per upload token that Google rejected.
 */
export async function batchCreatePhotos(
	items: UploadItem[],
	albumId?: string,
): Promise<Map<string, { message: string; retryable: boolean }>> {
	const createResponse = await requestWithRetry(
		() =>
			oauth2Client.request<BatchCreateResponse>({
				url: "https://photoslibrary.googleapis.com/v1/mediaItems:batchCreate",
				method: "POST",
				data: {
					albumId: albumId ? albumId : undefined,
					newMediaItems: items,
				},
			}),
		"Batch Create Media",
	);

	console.log("Batch create success:", createResponse.data);

	const rejected = new Map<string, { message: string; retryable: boolean }>();
	for (const result of createResponse.data.newMediaItemResults ?? []) {
		const code = result.status?.code ?? 0;
		if (code !== 0) {
			rejected.set(result.uploadToken, {
				message: result.status?.message || `error code ${code}`,
				// 3 = INVALID_ARGUMENT: Google won't take this file. Others may pass later.
				retryable: code !== 3,
			});
		}
	}
	return rejected;
}

export interface FileFailure {
	attachmentId: string;
	name: string;
	reason: string;
	retryable: boolean;
}

export interface UploadResult {
	numOfUploaded: number;
	uploadedIds: string[];
	failed: FileFailure[];
}

/**
 * Uploads a message's attachments. Doesn't throw for failed files: each one is
 * listed in `failed` with whether a later retry may work.
 */
export async function uploadPhotos(
	attachments: Attachment[],
	albumId: string,
	options: UploadOptions,
): Promise<UploadResult> {
	if (attachments.length === 0) {
		throw new Error("No attachments to upload.");
	}

	const description = tagDescriptionWithMessageId(
		`Uploaded by: ${options.uploaderDisplayName} (${options.uploaderName})`,
		options.messageId,
	);
	const fallbackDate = new Date(options.uploadTimestamp);

	const failed: FileFailure[] = [];
	const ready: { attachment: Attachment; item: UploadItem }[] = [];

	const settled = await Promise.allSettled(
		attachments.map((attachment) =>
			uploadBytesToGooglePhotos(attachment, fallbackDate),
		),
	);
	settled.forEach((outcome, i) => {
		const attachment = attachments[i] as Attachment;
		if (outcome.status === "fulfilled") {
			ready.push({ attachment, item: { ...outcome.value, description } });
		} else {
			const error = outcome.reason;
			failed.push({
				attachmentId: attachment.id,
				name: attachment.name,
				reason: error instanceof Error ? error.message : String(error),
				retryable: error instanceof UploadFileError ? error.retryable : true,
			});
		}
	});

	const uploadedIds: string[] = [];
	if (ready.length) {
		try {
			const rejected = await batchCreatePhotos(
				ready.map((r) => r.item),
				albumId,
			);
			for (const { attachment, item } of ready) {
				const problem = rejected.get(item.simpleMediaItem.uploadToken);
				if (problem) {
					failed.push({
						attachmentId: attachment.id,
						name: attachment.name,
						reason: `Google Photos rejected it (${problem.message})`,
						retryable: problem.retryable,
					});
				} else {
					uploadedIds.push(attachment.id);
				}
			}
		} catch (error) {
			console.error("Error creating media items in Google Photos:", error);
			// Upload tokens expire, so a retry uploads the bytes again from scratch.
			for (const { attachment } of ready) {
				failed.push({
					attachmentId: attachment.id,
					name: attachment.name,
					reason: `adding to the album failed (${describeError(error)})`,
					retryable: true,
				});
			}
		}
	}

	return { numOfUploaded: uploadedIds.length, uploadedIds, failed };
}

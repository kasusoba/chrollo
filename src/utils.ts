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
 * Lightweight liveness check for the Google credentials. Forces a token refresh
 * if the access token is stale. Returns false only when the bot genuinely needs
 * to be re-authenticated — transient network/5xx errors are treated as healthy.
 */
export async function isGoogleAuthHealthy(): Promise<boolean> {
	if (!oauth2Client.credentials?.refresh_token) {
		return false;
	}
	try {
		await oauth2Client.request({
			url: "https://photoslibrary.googleapis.com/v1/albums?pageSize=1",
			method: "GET",
		});
		return true;
	} catch (error) {
		return !isAuthError(error);
	}
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
		throw new Error(
			"The selected album does not exist on Google Photos. Please select a valid album using /album.",
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

export async function uploadBytesToGooglePhotos(
	attachment: Attachment,
	fallbackDate: Date,
): Promise<UploadItem | null> {
	try {
		console.log(`Processing ${attachment.name}...`);

		const response = await fetch(attachment.url);
		const arrayBuffer = await response.arrayBuffer();

		const tempDir = os.tmpdir();
		const baseName = `${Date.now()}_${attachment.name}`;
		const inputPath = path.join(tempDir, baseName);
		const outputPath = path.join(tempDir, `processed_${baseName}`);

		// List of files to delete later
		const cleanupFiles = [inputPath, outputPath];

		// Determine File Type
		const ext = path.extname(attachment.name).toLowerCase();
		const isVideo = [".mp4", ".mov", ".mkv", ".avi", ".webm"].includes(ext);

		let finalBuffer: Buffer;

		try {
			// 1. Write the raw download to disk
			await fs.promises.writeFile(inputPath, Buffer.from(arrayBuffer));

			if (isVideo) {
				// --- VIDEO STRATEGY: FFmpeg ---
				console.log("> Type: Video. Using FFmpeg (Nuclear Option)...");
				try {
					await modifyVideoDate(inputPath, outputPath, fallbackDate);
					// Read the NEW file created by FFmpeg
					finalBuffer = await fs.promises.readFile(outputPath);
				} catch (e) {
					console.error("FFmpeg failed, falling back to original:", e);
					finalBuffer = await fs.promises.readFile(inputPath);
				}
			} else {
				// --- IMAGE STRATEGY: ExifTool ---
				console.log("> Type: Image. Using ExifTool...");

				// Read tags first to preserve existing dates (deduplication check)
				const tags = await exiftool.read(inputPath);
				if (tags.DateTimeOriginal) {
					console.log("> Existing EXIF found. Skipping modification.");
					finalBuffer = await fs.promises.readFile(inputPath);
				} else {
					// Write tags
					await exiftool.write(inputPath, {
						DateTimeOriginal: fallbackDate.toISOString(),
						CreateDate: fallbackDate.toISOString(),
						ModifyDate: fallbackDate.toISOString(),
						AllDates: fallbackDate.toISOString(),
					});

					cleanupFiles.push(`${inputPath}_original`); // Exiftool backup file
					finalBuffer = await fs.promises.readFile(inputPath);
				}
			}
		} finally {
			// Cleanup temp files (Non-blocking)
			Promise.all(
				cleanupFiles.map((f) => fs.promises.unlink(f).catch(() => {})),
			);
		}

		// Upload to Google Photos
		const uploadResponse = await oauth2Client.request<string>({
			url: "https://photoslibrary.googleapis.com/v1/uploads",
			method: "POST",
			headers: {
				"Content-type": "application/octet-stream",
				"X-Goog-Upload-Protocol": "raw",
				"X-Goog-Upload-Content-Type":
					attachment.contentType || "application/octet-stream",
			},
			data: finalBuffer,
		});

		return {
			simpleMediaItem: {
				uploadToken: uploadResponse.data,
				fileName: attachment.name,
			},
		};
	} catch (error) {
		console.error("Error uploading to Google Photos:", error);
		return null;
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

export async function batchCreatePhotos(items: UploadItem[], albumId?: string) {
	try {
		// Wrapped in retry logic
		const createResponse = await requestWithRetry(
			() =>
				oauth2Client.request({
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
	} catch (error) {
		console.error("Error creating media items in Google Photos:", error);
		// Note: If batchCreate fails partly, you might need deeper inspection of createResponse.data
		// but for network errors, the retry handles it.
	}
}

export async function uploadPhotos(
	attachments: Attachment[],
	albumId: string,
	options: UploadOptions,
) {
	if (attachments.length === 0) {
		throw new Error("No attachments to upload.");
	}

	const description = tagDescriptionWithMessageId(
		`Uploaded by: ${options.uploaderDisplayName} (${options.uploaderName})`,
		options.messageId,
	);
	const fallbackDate = new Date(options.uploadTimestamp);

	// Execute uploads in parallel
	const uploadJobs = attachments.map((attachment) =>
		uploadBytesToGooglePhotos(attachment, fallbackDate),
	);

	const uploadResults = await Promise.all(uploadJobs);
	const successfulUploads = uploadResults
		.filter((result): result is UploadItem => result !== null)
		.map((item) => {
			if (description) {
				return { ...item, description };
			}
			return item;
		});

	if (successfulUploads.length === 0) {
		throw new Error("No attachments to upload.");
	}

	try {
		await batchCreatePhotos(successfulUploads, albumId);
		return {
			numOfUploaded: successfulUploads.length,
		};
	} catch (error) {
		console.error("Error creating media items in Google Photos:", error);
		throw error;
	}
}

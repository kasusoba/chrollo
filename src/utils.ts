import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Attachment } from "discord.js";
import { exiftool } from "exiftool-vendored";
import { oauth2Client } from "./googleClient.js";

export const eiBotTestChannelId = "1450051502348439684";
export const omoideChannelId = "1046093481774424184";
export const botbgmChannelId = "694798318328610886";

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
}

// --- ERROR HANDLING HELPERS ---

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wraps an API request with retry logic based on Google Cloud API recommendations.
 * - 5xx: Exponential backoff (starting at 1s)
 * - 429: Wait 30s minimum
 * - Other 4xx: Fail immediately
 */
async function requestWithRetry<T>(
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
	} catch (_error) {
		throw new Error(
			"The selected album does not exist on Google Photos. Please select a valid album using /album.",
		);
	}
}

export async function uploadBytesToGooglePhotos(
	attachment: Attachment,
	fallbackDate: Date,
): Promise<UploadItem | null> {
	try {
		console.log(`Processing ${attachment.name}...`);

		// Note: We are not retrying the Discord download here, but you could wrap this fetch in a retry too if needed.
		const response = await fetch(attachment.url);
		if (!response.ok)
			throw new Error(`Failed to fetch attachment: ${response.statusText}`);

		const arrayBuffer = await response.arrayBuffer();
		let mediaBuffer = Buffer.from(arrayBuffer);

		const tempFilePath = path.join(
			os.tmpdir(),
			`${Date.now()}_${attachment.name}`,
		);

		const cleanupFiles: string[] = [tempFilePath];

		try {
			await fs.promises.writeFile(tempFilePath, mediaBuffer);

			const tags = await exiftool.read(tempFilePath);
			const existingDate = tags.DateTimeOriginal || tags.CreateDate;

			if (existingDate) {
				console.log(
					`> [Info] ${attachment.name} has existing EXIF date (${existingDate.toString()}). Uploading original bytes to preserve Dedup.`,
				);
			} else {
				console.log(
					`> [Warning] ${attachment.name} has NO date. Injecting Discord timestamp (${fallbackDate.toISOString()})...`,
				);

				await exiftool.write(tempFilePath, {
					DateTimeOriginal: fallbackDate.toISOString(),
					CreateDate: fallbackDate.toISOString(),
					ModifyDate: fallbackDate.toISOString(),
					AllDates: fallbackDate.toISOString(),
				});

				cleanupFiles.push(`${tempFilePath}_original`);
				mediaBuffer = await fs.promises.readFile(tempFilePath);
			}
		} catch (e) {
			console.error("Error processing metadata:", e);
		} finally {
			for (const file of cleanupFiles) {
				try {
					if (fs.existsSync(file)) await fs.promises.unlink(file);
				} catch (_err) {
					/* ignore cleanup errors */
				}
			}
		}

		// Wrapped in retry logic
		// Uploads are the most likely to fail due to network hiccups (5xx)
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
					data: mediaBuffer,
				}),
			`Upload Bytes: ${attachment.name}`,
		);

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

	const description = `Uploaded by: ${options.uploaderDisplayName} (${options.uploaderName})`;
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

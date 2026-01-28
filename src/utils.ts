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
		await oauth2Client.request({
			url: `https://photoslibrary.googleapis.com/v1/albums/${album.id}`,
			method: "GET",
		});

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

		const response = await fetch(attachment.url);
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

		const uploadResponse = await oauth2Client.request<string>({
			url: "https://photoslibrary.googleapis.com/v1/uploads",
			method: "POST",
			headers: {
				"Content-type": "application/octet-stream",
				"X-Goog-Upload-Protocol": "raw",
				"X-Goog-Upload-Content-Type":
					attachment.contentType || "application/octet-stream",
			},
			data: mediaBuffer,
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

export async function batchCreatePhotos(items: UploadItem[], albumId?: string) {
	try {
		const createResponse = await oauth2Client.request({
			url: "https://photoslibrary.googleapis.com/v1/mediaItems:batchCreate",
			method: "POST",
			data: {
				albumId: albumId ? albumId : undefined,
				newMediaItems: items,
			},
		});

		console.log("Batch create success:", createResponse.data);
	} catch (error) {
		console.error("Error creating media items in Google Photos:", error);
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

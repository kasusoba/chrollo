import fs from "node:fs";
import path from "node:path";
import type { Attachment } from "discord.js";
import { oauth2Client } from "./googleClient.js";

export const eiBotTestChannelId = "1450051502348439684";

const ALBUM_FILE_NAME = "album.json";

export const ALBUM_PATH = path.join(process.cwd(), ALBUM_FILE_NAME);

interface Album {
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
	simpleMediaItem: {
		uploadToken: string;
		fileName: string;
	};
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

export async function uploadBytesToGooglePhotos(
	attachment: Attachment,
): Promise<UploadItem | null> {
	try {
		console.log(`Uploading ${attachment.name} to Google Photos...`);

		const response = fetch(attachment.url);
		const arrayBuffer = (await response).arrayBuffer();
		const imageBuffer = Buffer.from(await arrayBuffer);

		const uploadResponse = await oauth2Client.request<string>({
			url: "https://photoslibrary.googleapis.com/v1/uploads",
			method: "POST",
			headers: {
				"Content-type": "application/octet-stream",
				"X-Goog-Upload-Protocol": "raw",
				"X-Goog-Upload-Content-Type": attachment.contentType || "image/png",
			},
			data: imageBuffer,
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

export async function uploadPhotos(attachments: Attachment[], albumId: string) {
	if (attachments.length === 0) {
		throw new Error("No attachments to upload.");
	}

	if (!albumId) {
		throw new Error(
			"No album selected. Please select an album using /album before uploading.",
		);
	}

	const getResponse = await oauth2Client.request<GetAlbumsResponse>({
		url: "https://photoslibrary.googleapis.com/v1/albums",
		method: "GET",
	});

	const albumsArray = getResponse.data.albums || [];

	if (!albumsArray.find((a: GoogleAlbum) => a.id === albumId)) {
		throw new Error(
			"The selected album does not exist. Please select a valid album using /album before uploading.",
		);
	}

	const uploadJobs = attachments.map((attachment) =>
		uploadBytesToGooglePhotos(attachment),
	);

	const uploadResults = await Promise.all(uploadJobs);
	const successfulUploads = uploadResults.filter((result) => result !== null);

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

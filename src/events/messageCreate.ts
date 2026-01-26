import { type Attachment, Events, type Message } from "discord.js";
import { oauth2Client } from "../googleClient.js";
import { getAlbum } from "../utils.js";

const eiBotTestChannelId = "1450051502348439684";

async function uploadBytesToGooglePhotos(attachment: Attachment) {
	try {
		console.log(`Uploading ${attachment.name} to Google Photos...`);

		const response = fetch(attachment.url);
		const arrayBuffer = (await response).arrayBuffer();
		const imageBuffer = Buffer.from(await arrayBuffer);

		const uploadResponse = await oauth2Client.request({
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

export default {
	name: Events.MessageCreate,
	async execute(message: Message) {
		if (message.author.bot) return;
		if (message.channelId !== eiBotTestChannelId) return;
		if (!oauth2Client.credentials || !oauth2Client.credentials.refresh_token) {
			console.log("Not logged in yet");
			return;
		}

		const album = getAlbum();
		const albumId = album?.id;

		if (!albumId) {
			message.reply(
				"No album selected. Please select an album before uploading.",
			);
			return;
		}

		const getResponse = await oauth2Client.request({
			url: "https://photoslibrary.googleapis.com/v1/albums",
			method: "GET",
		});

		const albumsArray = getResponse.data.albums || [];

		if (!albumsArray.find((a: any) => a.id === albumId)) {
			message.reply(
				"The selected album does not exist. Please select a valid album before uploading.",
			);
			return;
		}

		const uploadJobs = Array.from(message.attachments.values()).map(
			(attachment) => uploadBytesToGooglePhotos(attachment),
		);

		const uploadResults = await Promise.all(uploadJobs);
		const successfulUploads = uploadResults.filter((result) => result !== null);

		if (successfulUploads.length === 0) {
			message.reply("No attachments to upload.");
			return;
		}

		try {
			const createResponse = await oauth2Client.request({
				url: "https://photoslibrary.googleapis.com/v1/mediaItems:batchCreate",
				method: "POST",
				data: {
					albumId: albumId,
					newMediaItems: successfulUploads,
				},
			});

			console.log("Batch create success:", createResponse.data);
			message.reply(
				`Successfully uploaded **${successfulUploads.length}** images to Google Photos album **${album?.title}**!`,
			);
		} catch (error) {
			console.error("Error creating media items in Google Photos:", error);
			message.reply("Failed to upload photos to Google Photos.");
		}
	},
};

import { Events, type Message } from "discord.js";
import { oauth2Client } from "../googleClient.js";
import { eiBotTestChannelId, getAlbum, uploadPhotos } from "../utils.js";

export default {
	name: Events.MessageCreate,
	async execute(message: Message) {
		if (message.author.bot) return;
		if (message.channelId !== eiBotTestChannelId) return;
		if (!oauth2Client.credentials || !oauth2Client.credentials.refresh_token) {
			console.log("Not logged in yet");
			return;
		}
		if (message.attachments.size === 0) return;

		try {
			const album = getAlbum();
			const albumId = album?.id;

			if (!albumId) {
				message.reply(
					"No album selected. Please select an album using /album before uploading.",
				);
				return;
			}

			const uploadResponse = await uploadPhotos(
				Array.from(message.attachments.values()),
				albumId,
			);
			message.reply(
				`Successfully uploaded **${uploadResponse.numOfUploaded}** images to Google Photos album **${album?.title}**!`,
			);
		} catch (error) {
			console.error("Error uploading photos:", error);
			message.reply(error instanceof Error ? error.message : "Unknown error");
		}
	},
};

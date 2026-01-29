import { Events, type Message } from "discord.js";
import { oauth2Client } from "../googleClient.js";
import {
	type Album,
	botbgmChannelId,
	eiBotTestChannelId,
	getValidatedAlbum,
	omoideChannelId,
	uploadPhotos,
} from "../utils.js";

export default {
	name: Events.MessageCreate,
	async execute(message: Message) {
		if (message.author.bot) return;
		if (
			message.channelId !== omoideChannelId &&
			message.channelId !== botbgmChannelId &&
			message.channelId !== eiBotTestChannelId
		)
			return;

		if (!oauth2Client.credentials || !oauth2Client.credentials.refresh_token) {
			console.log("Not logged in yet");
			return;
		}
		if (message.attachments.size === 0) return;

		try {
			let album: Album;
			try {
				album = await getValidatedAlbum();
			} catch (error) {
				message.reply(error instanceof Error ? error.message : "Album error");
				return;
			}
			const albumId = album.id;

			const uploadResponse = await uploadPhotos(
				Array.from(message.attachments.values()),
				albumId,
				{
					uploaderName: message.author.username,
					uploaderDisplayName:
						message.member?.displayName ??
						message.author.displayName ??
						message.author.username,
					uploadTimestamp: message.createdTimestamp,
				},
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

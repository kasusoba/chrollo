import { Events, type Message, MessageFlags } from "discord.js";
import { oauth2Client } from "../googleClient.js";
import {
	type Album,
	getAuthUrl,
	getValidatedAlbum,
	OPERATING_CHANNEL_ID,
	OPERATING_GUILD_ID,
	uploadPhotos,
} from "../utils.js";

export default {
	name: Events.MessageCreate,
	async execute(message: Message) {
		if (message.author.bot) return;
		if (
			message.guildId !== OPERATING_GUILD_ID ||
			message.channelId !== OPERATING_CHANNEL_ID
		)
			return;

		if (message.attachments.size === 0 && message.messageSnapshots.size === 0)
			return;

		if (!oauth2Client.credentials || !oauth2Client.credentials.refresh_token) {
			message.reply(
				`Bot isn't connected to Google yet. Log in here: ${getAuthUrl()}`,
			);
			return;
		}

		try {
			let album: Album;
			try {
				album = await getValidatedAlbum();
			} catch (error) {
				message.reply(error instanceof Error ? error.message : "Album error");
				return;
			}
			const albumId = album.id;

			const forwardedAttachments = message.messageSnapshots.size
				? Array.from(message.messageSnapshots.values()).flatMap((snapshot) =>
						Array.from(snapshot.attachments.values()),
					)
				: [];

			const uploadResponse = await uploadPhotos(
				Array.from(message.attachments.values()).concat(forwardedAttachments),
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
			// Routine confirmation fires on every photo, so keep it quiet (like a
			// leaderboard bot): no push notification and no reply ping.
			message.reply({
				content: `Successfully uploaded **${uploadResponse.numOfUploaded}** images to Google Photos album **${album?.title}**!`,
				flags: MessageFlags.SuppressNotifications,
				allowedMentions: { repliedUser: false },
			});
		} catch (error) {
			console.error("Error uploading photos:", error);
			message.reply(error instanceof Error ? error.message : "Unknown error");
		}
	},
};

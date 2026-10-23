import { Events, type Message } from "discord.js";
import { autoUpload } from "../autoUpload.js";
import { OPERATING_CHANNEL_ID, OPERATING_GUILD_ID } from "../utils.js";

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

		try {
			// Uploads, or queues the files and retries later if Google, the login
			// or the album is broken. The owner gets a DM from the health check.
			await autoUpload(message);
		} catch (error) {
			console.error("Error uploading photos:", error);
		}
	},
};

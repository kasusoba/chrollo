import { Events, type Message } from "discord.js";
import { autoUpload } from "../autoUpload.js";
import { isUploadChannel } from "../utils.js";

export default {
	name: Events.MessageCreate,
	async execute(message: Message) {
		if (message.author.bot) return;
		if (!isUploadChannel(message.channelId)) return;

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

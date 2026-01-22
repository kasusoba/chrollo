import { Attachment, Events, Message } from "discord.js";
import { oauth2Client } from "../googleClient.js";

const eiBotTestChannelId = "1450051502348439684";

export default {
	name: Events.MessageCreate,
	async execute(message: Message) {
		if (message.author.bot) return;

		const userAttachments = message.attachments.map((val, key, map) => {
			return val;
		});

		if (message.channelId === eiBotTestChannelId) {
			if (
				!oauth2Client.credentials ||
				!oauth2Client.credentials.refresh_token
			) {
				console.log("Not logged in yet");
				return;
			}

			try {
				const url = "https://photoslibrary.googleapis.com/v1/albums";

				const response = await oauth2Client.request({
					url: url,
					method: "GET",
				});
				console.log(response.data);

				message.reply({
					content: message.content + JSON.stringify(response.data),
					files: userAttachments,
				});
			} catch (error: any) {
				console.error(
					"API Error:",
					error.response ? error.response.data : error.message,
				);
				message.reply(`API Error: ${error.message}`);
			}
		}
	},
};

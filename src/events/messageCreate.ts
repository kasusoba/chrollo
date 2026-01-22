import { Attachment, Events, Message } from "discord.js";

const eiBotTestChannelId = "1450051502348439684";

export default {
	name: Events.MessageCreate,
	async execute(message: Message) {
		if (message.author.bot) return;

		const userAttachments = message.attachments.map((val, key, map) => {
			return val;
		});

		if (message.channelId === eiBotTestChannelId) {
			message.reply({
				content: message.content,
				files: userAttachments,
			});
		}
	},
};

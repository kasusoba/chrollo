import { Attachment, Events, Message } from "discord.js";

const eiBotTestChannelId = "1450051502348439684";

export default {
	name: Events.MessageCreate,
	async execute(message: Message) {
		if (message.author.bot) return;

		console.log(message);
		const userAttachments = message.attachments.map((val, key, map) => {
			return val;
		});
		console.log(userAttachments);

		if (message.channelId === eiBotTestChannelId) {
			message.reply({
				content: message.content,
				files: userAttachments,
			});
		}
	},
};

import { type Client, Events } from "discord.js";

export default {
	name: Events.ClientReady,
	once: true,
	execute(client: Client<true>) {
		console.log(`Ready! On My Way! ${client.user.tag}`);
	},
};

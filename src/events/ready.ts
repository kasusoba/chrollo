import { type Client, Events } from "discord.js";
import { startHealthMonitor } from "../health.js";

export default {
	name: Events.ClientReady,
	once: true,
	async execute(client: Client<true>) {
		console.log(`Ready! On My Way! ${client.user.tag}`);
		// Checks Google, auth and the album now and on a timer, and DMs
		// DISCORD_OWNER_ID when something breaks or recovers.
		startHealthMonitor(client);
	},
};

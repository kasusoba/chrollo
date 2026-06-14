import { type Client, Events } from "discord.js";
import { getAuthUrl, isGoogleAuthHealthy } from "../utils.js";

export default {
	name: Events.ClientReady,
	once: true,
	async execute(client: Client<true>) {
		console.log(`Ready! On My Way! ${client.user.tag}`);

		const ownerId = process.env.DISCORD_OWNER_ID;
		if (!ownerId) {
			console.warn(
				"[STARTUP] DISCORD_OWNER_ID not set — skipping Google auth health check.",
			);
			return;
		}

		if (await isGoogleAuthHealthy()) {
			console.log("[STARTUP] Google auth OK.");
			return;
		}

		console.warn("[STARTUP] Google auth is dead — notifying owner.");
		try {
			const owner = await client.users.fetch(ownerId);
			await owner.send(
				`⚠️ Chrollo booted but isn't connected to Google. Log in here: ${getAuthUrl()}`,
			);
		} catch (error) {
			console.error("[STARTUP] Failed to DM owner:", error);
		}
	},
};

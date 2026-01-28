import { REST, Routes } from "discord.js";
import "dotenv/config";

const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
	console.error("❌ Error: Missing DISCORD_TOKEN or CLIENT_ID in .env");
	process.exit(1);
}

const rest = new REST().setToken(DISCORD_TOKEN);

const commandId = "asd"; // Replace with the actual command ID to delete

(async () => {
	try {
		console.log(`🗑️  Attempting to delete command: ${commandId}...`);

		// OPTION A: Delete Global Command
		// await rest.delete(Routes.applicationCommand(DISCORD_CLIENT_ID, commandId));

		// OPTION B: Delete Guild Specific Command (Uncomment if you use guild commands)
		if (!DISCORD_GUILD_ID) throw new Error("Missing GUILD_ID");
		await rest.delete(
			Routes.applicationGuildCommand(
				DISCORD_CLIENT_ID,
				DISCORD_GUILD_ID,
				commandId,
			),
		);

		// rest
		// 	.put(
		// 		Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID),
		// 		{ body: [] },
		// 	)
		// 	.then(() => console.log("Successfully deleted all guild commands."))
		// 	.catch(console.error);

		console.log(`✅ Successfully deleted command ${commandId}`);
	} catch (error) {
		console.error("❌ Failed to delete command:", error);
	}
})();

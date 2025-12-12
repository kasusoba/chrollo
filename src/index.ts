import {
	Client,
	Collection,
	Events,
	GatewayIntentBits,
	MessageFlags,
	SlashCommandSubcommandGroupBuilder,
} from "discord.js";
import "dotenv/config";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

// ==========
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// ==========

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
	],
});

client.once(Events.ClientReady, (readyClient) => {
	console.log(`Ready euy ${readyClient.user.tag}`);
});

client.commands = new Collection();

const foldersPath = path.join(__dirname, "commands");
const commandFolders = fs.readdirSync(foldersPath);

for (const folder of commandFolders) {
	const commandsPath = path.join(foldersPath, folder);
	const commandFiles = fs
		.readdirSync(commandsPath)
		.filter((file) => file.endsWith(".js"));

	for (const file of commandFiles) {
		const filePath = path.join(commandsPath, file);

		const commandModule = await import(filePath);

		// Support both ES exports AND CommonJS exports
		const command = commandModule.default ?? commandModule;

		if ("data" in command && "execute" in command) {
			client.commands.set(command.data.name, command);
		} else {
			console.log(`mana data sama execute nya brok di ${filePath}`);
		}
	}
}

client.on(Events.InteractionCreate, async (interaction) => {
	if (!interaction.isChatInputCommand()) return;

	const command = interaction.client.commands.get(interaction.commandName);

	if (!command) {
		console.error(`no matching command ${interaction.commandName}`);
		return;
	}

	try {
		await command.execute(interaction);
	} catch (error) {
		console.error(error);

		if (interaction.replied || interaction.deferred) {
			await interaction.followUp({
				content: "there was error execute command",
				flags: MessageFlags.Ephemeral,
			});
		} else {
			await interaction.reply({
				content: "error execute command",
				flags: MessageFlags.Ephemeral,
			});
		}
	}
});

client.login(process.env.DISCORD_TOKEN);

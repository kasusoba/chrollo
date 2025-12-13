import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const data = new SlashCommandBuilder()
	.setName("reload")
	.setDescription("Reloads a command.")
	.addStringOption((option) =>
		option
			.setName("command")
			.setDescription("The command to reload")
			.setRequired(true),
	);

export async function execute(interaction: ChatInputCommandInteraction) {
	const commandName = interaction.options
		.getString("command", true)
		.toLowerCase();

	const command = interaction.client.commands.get(commandName);

	if (!command) {
		return interaction.reply({
			content: `There is no command named \`${commandName}\`!`,
			ephemeral: true,
		});
	}

	try {
		const commandsPath = path.resolve("./commands");
		const commandPath = path.join(
			commandsPath,
			command.category, // if you store category on load
			`${commandName}.js`,
		);

		// 👇 cache-busting import
		const fileUrl = pathToFileURL(commandPath).href;
		const newCommand = await import(`${fileUrl}?update=${Date.now()}`);

		interaction.client.commands.set(newCommand.data.name, newCommand);

		await interaction.reply(
			`Command \`${newCommand.data.name}\` was reloaded!`,
		);
	} catch (error) {
		console.error(error);

		const message = error instanceof Error ? error.message : String(error);

		await interaction.reply(
			`Error reloading \`${commandName}\`:\n\`${message}\``,
		);
	}
}

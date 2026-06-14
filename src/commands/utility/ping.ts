import {
	type ChatInputCommandInteraction,
	InteractionContextType,
	SlashCommandBuilder,
} from "discord.js";

const ping = {
	cooldown: 5,
	data: new SlashCommandBuilder()
		.setName("ping")
		.setDescription("Replies with Pong!")
		.setContexts([
			InteractionContextType.Guild,
			InteractionContextType.BotDM,
		]),
	async execute(interaction: ChatInputCommandInteraction) {
		await interaction.reply("Pong!");
	},
};

export default ping;

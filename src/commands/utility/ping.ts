import {
	type ChatInputCommandInteraction,
	SlashCommandBuilder,
} from "discord.js";

const ping = {
	cooldown: 5,
	data: new SlashCommandBuilder()
		.setName("ping")
		.setDescription("Replies with Pong!"),
	async execute(interaction: ChatInputCommandInteraction) {
		await interaction.reply("Pong!");
	},
};

export default ping;

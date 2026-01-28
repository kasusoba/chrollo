import { Collection, Events, type Interaction, MessageFlags } from "discord.js";
import { botbgmChannelId, omoideChannelId } from "../utils.js";

export default {
	name: Events.InteractionCreate,
	async execute(interaction: Interaction) {
		if (!interaction.isChatInputCommand()) return;
		// if (interaction.channelId !== eiBotTestChannelId) return;
		if (
			interaction.channelId !== omoideChannelId &&
			interaction.channelId !== botbgmChannelId
		)
			return;

		const command = interaction.client.commands.get(interaction.commandName);

		if (!command) {
			console.error(`no matching command ${interaction.commandName}`);
			return;
		}

		const { cooldowns } = interaction.client;

		if (!cooldowns.has(command.data.name)) {
			cooldowns.set(command.data.name, new Collection());
		}

		const now = Date.now();
		const timestamps = cooldowns.get(command.data.name);
		const defaultCooldownDuration = 3;
		const cooldownAmount =
			(command.cooldown ?? defaultCooldownDuration) * 1_000;

		if (timestamps.has(interaction.user.id)) {
			const expirationTime =
				timestamps.get(interaction.user.id) + cooldownAmount;

			if (now < expirationTime) {
				const expiredTimestamp = Math.round(expirationTime / 1000);
				return interaction.reply({
					content: `Please wait bruh, cooldown for ${command.data.name}. Can Use after ${expiredTimestamp}`,
					flags: MessageFlags.Ephemeral,
				});
			}
		}

		timestamps.set(interaction.user.id, now);
		setTimeout(() => timestamps.delete(interaction.user.id, cooldownAmount));

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
	},
};

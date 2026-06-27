import { Collection, Events, type Interaction, MessageFlags } from "discord.js";
import { OPERATING_CHANNEL_ID, OPERATING_GUILD_ID } from "../utils.js";

export default {
	name: Events.InteractionCreate,
	async execute(interaction: Interaction) {
		if (!interaction.isChatInputCommand()) return;

		// Only the owner may control the bot.
		const ownerId = process.env.DISCORD_OWNER_ID;
		if (ownerId && interaction.user.id !== ownerId) {
			return interaction.reply({
				content: "You're not allowed to control this bot.",
				flags: MessageFlags.Ephemeral,
			});
		}

		// Allow control from the owner's DM or the operating channel only.
		const inDM = !interaction.inGuild();
		const inOperatingChannel =
			interaction.guildId === OPERATING_GUILD_ID &&
			interaction.channelId === OPERATING_CHANNEL_ID;
		if (!inDM && !inOperatingChannel) {
			return interaction.reply({
				content: "Use me in my DM or the omoide channel.",
				flags: MessageFlags.Ephemeral,
			});
		}

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
		setTimeout(() => timestamps.delete(interaction.user.id), cooldownAmount);

		try {
			await command.execute(interaction);
		} catch (error) {
			console.error(error);

			// Notifying the user can itself fail (e.g. the interaction already
			// expired — 10062). Swallow that so it doesn't crash the client via
			// an unhandled 'error' event.
			try {
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
			} catch (replyError) {
				console.error("Failed to notify user of command error:", replyError);
			}
		}
	},
};

import {
	type ChatInputCommandInteraction,
	InteractionContextType,
	MessageFlags,
	SlashCommandBuilder,
} from "discord.js";
import { dropQueuedForChannel } from "../../autoUpload.js";
import { triggerHealthCheck } from "../../health.js";
import { channelLabel, getAlbum, unlinkChannel } from "../../utils.js";

export const data = new SlashCommandBuilder()
	.setName("unlink")
	.setDescription("Stop uploading photos from this channel.")
	.setContexts([InteractionContextType.Guild]);

export async function execute(interaction: ChatInputCommandInteraction) {
	const channelId = interaction.channelId;
	const album = getAlbum(channelId);
	const label = channelLabel(channelId);

	if (!album) {
		await interaction.reply({
			content: "This channel isn't uploading anything. Use /link to start.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	const dropped = dropQueuedForChannel(channelId);
	unlinkChannel(channelId);
	triggerHealthCheck();

	const droppedText = dropped
		? ` ${dropped} file(s) that were waiting to upload were dropped.`
		: "";
	await interaction.reply({
		content: `Stopped uploading from **#${label}**. The album **${album.title}** stays in Google Photos.${droppedText} Use /link to start again.`,
		flags: MessageFlags.Ephemeral,
	});
}

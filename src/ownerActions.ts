import { type ButtonInteraction, MessageFlags } from "discord.js";
import * as linkCommand from "./commands/core/link.js";
import statusCommand from "./commands/utility/status.js";
import {
	albumCheckFor,
	OWNER_BUTTON,
	runHealthCheck,
	triggerHealthCheck,
} from "./health.js";
import { channelLabel, getAlbum, isUploadChannel } from "./utils.js";

/** Handles the buttons on the health alert DM. Returns false if not ours. */
export async function handleOwnerButton(
	interaction: ButtonInteraction,
): Promise<boolean> {
	const id = interaction.customId;
	if (!id.startsWith("owner:")) return false;

	const ownerId = process.env.DISCORD_OWNER_ID;
	if (ownerId && interaction.user.id !== ownerId) {
		await interaction.reply({
			content: "Only the bot owner can use this.",
			flags: MessageFlags.Ephemeral,
		});
		return true;
	}

	if (id === OWNER_BUTTON.status) {
		await statusCommand.execute(interaction);
	} else if (id.startsWith(OWNER_BUTTON.pickAlbum)) {
		const channelId = id.slice(OWNER_BUTTON.pickAlbum.length);
		if (isUploadChannel(channelId)) {
			await linkCommand.execute(interaction, channelId);
		}
	} else if (id.startsWith(OWNER_BUTTON.recreateAlbum)) {
		const channelId = id.slice(OWNER_BUTTON.recreateAlbum.length);
		if (isUploadChannel(channelId)) await recreateAlbum(interaction, channelId);
	}
	return true;
}

async function recreateAlbum(
	interaction: ButtonInteraction,
	channelId: string,
) {
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });

	// The alert may be old, so check the current state before creating anything.
	const report = await runHealthCheck();
	const label = channelLabel(channelId);
	const check = albumCheckFor(report, channelId);
	if (check?.state === "ok") {
		await interaction.editReply(
			`The album for #${label} is working already (${check.detail}). Nothing to do.`,
		);
		return;
	}
	if (report.google.state === "fail" || report.auth.state === "fail") {
		await interaction.editReply(
			`Can't create an album right now. Google: ${report.google.detail || "-"}, Auth: ${report.auth.detail || "-"}.`,
		);
		return;
	}

	const title = getAlbum(channelId)?.title || label;
	await linkCommand.createAndLinkAlbum(channelId, label, title);
	triggerHealthCheck();
	await interaction.editReply(
		`Created a new album **${title}** for #${label}. Waiting photos will upload in a moment. The new album starts empty: photos from the old one are still in your Google Photos library.`,
	);
}

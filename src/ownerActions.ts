import { type ButtonInteraction, MessageFlags } from "discord.js";
import * as albumCommand from "./commands/core/album.js";
import statusCommand from "./commands/utility/status.js";
import { OWNER_BUTTON, runHealthCheck, triggerHealthCheck } from "./health.js";
import { getAlbum } from "./utils.js";

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
	} else if (id === OWNER_BUTTON.pickAlbum) {
		await albumCommand.execute(interaction);
	} else if (id === OWNER_BUTTON.recreateAlbum) {
		await recreateAlbum(interaction);
	}
	return true;
}

async function recreateAlbum(interaction: ButtonInteraction) {
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });

	// The alert may be old, so check the current state before creating anything.
	const report = await runHealthCheck();
	if (report.album.state === "ok") {
		await interaction.editReply(
			`The album is working already (${report.album.detail}). Nothing to do.`,
		);
		return;
	}
	if (report.google.state === "fail" || report.auth.state === "fail") {
		await interaction.editReply(
			`Can't create an album right now. Google: ${report.google.detail || "-"}, Auth: ${report.auth.detail || "-"}.`,
		);
		return;
	}

	const title = getAlbum()?.title || "omoide";
	await albumCommand.createAndSelectAlbum(title);
	triggerHealthCheck();
	await interaction.editReply(
		`Created and selected a new album **${title}**. Waiting photos will upload in a moment. The new album starts empty: photos from the old one are still in your Google Photos library.`,
	);
}

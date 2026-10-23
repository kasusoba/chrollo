import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	type ChatInputCommandInteraction,
	ComponentType,
	InteractionContextType,
	MessageFlags,
	SlashCommandBuilder,
} from "discord.js";
import {
	type Album,
	batchRemoveMediaItems,
	getAllMediaItemsInAlbum,
	getValidatedAlbum,
} from "../../utils.js";

export const data = new SlashCommandBuilder()
	.setName("clearalbum")
	.setDescription(
		"Remove all bot-uploaded photos from this channel's album. They stay in your library.",
	)
	.setContexts([InteractionContextType.Guild]);

export async function execute(interaction: ChatInputCommandInteraction) {
	// 1. Validation and Setup
	await interaction.deferReply({ flags: MessageFlags.Ephemeral });

	let album: Album;
	try {
		album = await getValidatedAlbum(interaction.channelId);
	} catch (e: any) {
		await interaction.editReply({ content: e.message });
		return;
	}

	// 2. Fetch Items
	await interaction.editReply({
		content: `Scanning album **${album.title}** for items...`,
	});

	let mediaIds: string[] = [];
	try {
		mediaIds = await getAllMediaItemsInAlbum(album.id);
	} catch (error) {
		console.error(error);
		await interaction.editReply({ content: "Error fetching media items." });
		return;
	}

	if (mediaIds.length === 0) {
		await interaction.editReply({
			content: `Album **${album.title}** is already empty (or contains no API-accessible items).`,
		});
		return;
	}

	// 3. Confirmation Prompt
	const confirmButton = new ButtonBuilder()
		.setCustomId("confirm_purge")
		.setLabel(`Yes, remove ${mediaIds.length} items`)
		.setStyle(ButtonStyle.Danger);

	const cancelButton = new ButtonBuilder()
		.setCustomId("cancel_purge")
		.setLabel("Cancel")
		.setStyle(ButtonStyle.Secondary);

	const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
		cancelButton,
		confirmButton,
	);

	const response = await interaction.editReply({
		content: `⚠️ **WARNING** ⚠️\nYou are about to remove **${mediaIds.length}** media items from album **${album.title}**.\n\nThe photos stay in your Google Photos library, only the album is emptied. Only items the bot uploaded can be removed.\nAfterwards /upload no longer knows these messages were uploaded, so running it over the same messages uploads them again.\n\nProceed?`,
		components: [row],
	});

	// 4. Handle Confirmation
	const collector = response.createMessageComponentCollector({
		componentType: ComponentType.Button,
		time: 30000,
	});

	collector.on("collect", async (i) => {
		if (i.user.id !== interaction.user.id) {
			await i.reply({
				content: "This isn't your command.",
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		if (i.customId === "cancel_purge") {
			await i.update({
				content: "Cancelled, nothing removed.",
				components: [],
			});
			return;
		}

		if (i.customId === "confirm_purge") {
			await i.update({
				content: `Removing ${mediaIds.length} items. This may take a moment...`,
				components: [],
			});

			try {
				const count = await batchRemoveMediaItems(album.id, mediaIds);
				await interaction.followUp({
					content: `✅ Successfully removed **${count}** items from **${album.title}**.`,
					flags: MessageFlags.Ephemeral,
				});
			} catch (error) {
				console.error(error);
				await interaction.followUp({
					content:
						"❌ An error occurred during removal. \n**Note:** The API will fail if you try to remove items NOT created by this app. If you have mixed content in this album, this command might fail.",
					flags: MessageFlags.Ephemeral,
				});
			}
		}
	});

	collector.on("end", async (collected) => {
		if (collected.size === 0) {
			await interaction.editReply({
				content: "Timed out, nothing removed.",
				components: [],
			});
		}
	});
}

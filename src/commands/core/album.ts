import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	type ChatInputCommandInteraction,
	ModalBuilder,
	SlashCommandBuilder,
	StringSelectMenuBuilder,
	StringSelectMenuOptionBuilder,
	TextInputBuilder,
	TextInputStyle,
	LabelBuilder,
	MessageFlags,
} from "discord.js";
import { oauth2Client } from "../../googleClient.js";
import fs from "node:fs";
import { ALBUM_PATH, getAlbum } from "../../utils.js";

function saveAlbumFile(albumObject: { id: string; title: string }) {
	if (fs.existsSync(ALBUM_PATH)) {
		const currentData = JSON.parse(fs.readFileSync(ALBUM_PATH, "utf-8"));
		const newData = { ...currentData, ...albumObject };
		fs.writeFileSync(ALBUM_PATH, JSON.stringify(newData, null, 2));
		console.log("[INTERACTION: Album] Album updated in album.json");
	} else {
		console.log("[INTERACTION: Album] No album found. Creating album.json");
		fs.writeFileSync(ALBUM_PATH, JSON.stringify(albumObject, null, 2));
		console.log("[INTERACTION: Album] Album saved to disk.");
	}
}

export const data = new SlashCommandBuilder()
	.setName("album")
	.setDescription("Manage albums.");

export async function execute(interaction: ChatInputCommandInteraction) {
	const getResponse = await oauth2Client.request({
		url: "https://photoslibrary.googleapis.com/v1/albums",
		method: "GET",
	});

	console.log("Get albums response:", getResponse.data);

	const albumsArray = getResponse.data.albums || [];

	const currentAlbumId = getAlbum()?.id;

	const rows: ActionRowBuilder<any>[] = [];

	rows.push(
		new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder()
				.setCustomId("create")
				.setLabel("Create New Album")
				.setStyle(ButtonStyle.Primary),
		),
	);

	if (albumsArray.length) {
		const selectAlbum = new StringSelectMenuBuilder()
			.setCustomId("select")
			.setPlaceholder("Select an album")
			.addOptions(
				albumsArray.map((album: any) =>
					new StringSelectMenuOptionBuilder()
						.setLabel(album.title)
						.setValue(album.id)
						.setEmoji(album.id === currentAlbumId ? "✅" : "📁"),
				),
			);

		rows.push(
			new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
				selectAlbum,
			),
		);
	}

	rows.push(
		new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder()
				.setCustomId("cancel")
				.setLabel("Cancel")
				.setStyle(ButtonStyle.Secondary),
		),
	);

	const response = await interaction.reply({
		content: "Choose an option to manage albums:",
		components: rows,
		withResponse: true,
		flags: MessageFlags.Ephemeral,
	});

	try {
		const confirmation =
			await response.resource?.message?.awaitMessageComponent({
				filter: (i) => i.user.id === interaction.user.id,
				time: 60000,
			});

		if (!confirmation) return;

		if (confirmation.customId === "create") {
			const modal = new ModalBuilder()
				.setCustomId("createModal")
				.setTitle("Create New Album");

			const albumNameInput = new TextInputBuilder()
				.setCustomId("albumNameInput")
				.setStyle(TextInputStyle.Short)
				.setPlaceholder("Your Album Name");
			const albumNameLabel = new LabelBuilder()
				.setLabel("Album Name")
				.setDescription("Enter the name of your new album")
				.setTextInputComponent(albumNameInput);
			modal.addLabelComponents(albumNameLabel);

			await confirmation.showModal(modal);

			const modalSubmission = await confirmation.awaitModalSubmit({
				time: 60000,
				filter: (i) =>
					i.customId === "createModal" && i.user.id === interaction.user.id,
			});

			const albumName =
				modalSubmission.fields.getTextInputValue("albumNameInput");

			await modalSubmission.deferUpdate();

			const createResponse = await oauth2Client.request({
				url: "https://photoslibrary.googleapis.com/v1/albums",
				method: "POST",
				headers: { "Content-type": "application/json" },
				data: { album: { title: albumName } },
			});

			console.log("Album creation success:", createResponse.data);

			saveAlbumFile({
				id: createResponse.data.id,
				title: albumName,
			});

			await interaction.editReply({
				content: `Album **${albumName}** created and selected successfully!`,
				components: [],
			});
		} else if (confirmation.customId === "select") {
			if (!confirmation.isStringSelectMenu()) return;

			const selectedAlbumId = confirmation.values[0];

			if (!selectedAlbumId) {
				await confirmation.update({
					content: "No album selected.",
					components: [],
				});
				return;
			}

			const albumTitle =
				albumsArray.find((album: any) => album.id === selectedAlbumId)?.title ||
				"";

			if (currentAlbumId !== selectedAlbumId) {
				saveAlbumFile({
					id: selectedAlbumId,
					title: albumTitle,
				});
			}

			await confirmation.update({
				content: `Album **${albumTitle}** selected successfully!`,
				components: [],
			});
		} else if (confirmation.customId === "cancel") {
			await confirmation.update({
				content: "Action cancelled",
				components: [],
			});
		}
	} catch (error) {
		console.error(error);

		await interaction.editReply({
			content: "Action timed out or cancelled.",
			components: [],
		});
	}
}

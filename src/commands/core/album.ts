import {
	ActionRowBuilder,
	ButtonBuilder,
	type ButtonInteraction,
	ButtonStyle,
	type ChatInputCommandInteraction,
	InteractionContextType,
	LabelBuilder,
	MessageFlags,
	ModalBuilder,
	SlashCommandBuilder,
	StringSelectMenuBuilder,
	StringSelectMenuOptionBuilder,
	TextInputBuilder,
	TextInputStyle,
} from "discord.js";
import { oauth2Client } from "../../googleClient.js";
import { triggerHealthCheck } from "../../health.js";
import {
	channelLabel,
	commandChannelId,
	type GetAlbumsResponse,
	type GoogleAlbum,
	getAlbum,
	saveAlbum,
	UPLOAD_CHANNELS,
} from "../../utils.js";

function selectAlbum(channelId: string, album: { id: string; title: string }) {
	saveAlbum(channelId, album);
	triggerHealthCheck();
}

export const data = new SlashCommandBuilder()
	.setName("album")
	.setDescription("Choose the album a channel uploads to.")
	.setContexts([InteractionContextType.Guild, InteractionContextType.BotDM])
	.addStringOption((option) =>
		option
			.setName("channel")
			.setDescription(
				"Which channel (default: the one you're in, or omoide from DM)",
			)
			.addChoices(UPLOAD_CHANNELS.map((c) => ({ name: c.label, value: c.id }))),
	);

/** Creates a Google Photos album and makes it the upload target. */
export async function createAndSelectAlbum(
	channelId: string,
	title: string,
): Promise<GoogleAlbum> {
	const createResponse = await oauth2Client.request<GoogleAlbum>({
		url: "https://photoslibrary.googleapis.com/v1/albums",
		method: "POST",
		headers: { "Content-type": "application/json" },
		data: { album: { title } },
	});
	console.log("Album creation success:", createResponse.data);
	selectAlbum(channelId, { id: createResponse.data.id, title });
	return createResponse.data;
}

export async function execute(
	interaction: ChatInputCommandInteraction | ButtonInteraction,
	forChannelId?: string,
) {
	const channelId =
		forChannelId ??
		(interaction.isChatInputCommand()
			? interaction.options.getString("channel")
			: null) ??
		commandChannelId(interaction);
	const label = channelLabel(channelId);

	const getResponse = await oauth2Client.request<GetAlbumsResponse>({
		url: "https://photoslibrary.googleapis.com/v1/albums",
		method: "GET",
	});

	console.log("Get albums response:", getResponse.data);

	const albumsArray = getResponse.data.albums || [];

	const currentAlbumId = getAlbum(channelId)?.id;

	const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];

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
				albumsArray.map((album) =>
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
		content: `Choose the album for **#${label}**:`,
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

			await createAndSelectAlbum(channelId, albumName);

			await interaction.editReply({
				content: `Album **${albumName}** created and selected for **#${label}**!`,
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
				albumsArray.find((album) => album.id === selectedAlbumId)?.title || "";

			if (currentAlbumId !== selectedAlbumId) {
				selectAlbum(channelId, { id: selectedAlbumId, title: albumTitle });
			}

			await confirmation.update({
				content: `Album **${albumTitle}** selected for **#${label}**!`,
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

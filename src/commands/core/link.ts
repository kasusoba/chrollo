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
	PermissionFlagsBits,
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
	describeError,
	type GetAlbumsResponse,
	type GoogleAlbum,
	getAlbum,
	linkChannel,
} from "../../utils.js";

// /link: start uploading photos from this channel to an album, or switch the
// album. The owner alert DM reuses this with a channel ID.

export const data = new SlashCommandBuilder()
	.setName("link")
	.setDescription("Upload photos from this channel to a Google Photos album.")
	.setContexts([InteractionContextType.Guild]);

// What the bot needs in a channel to upload and report back.
const NEEDED = [
	["View Channel", PermissionFlagsBits.ViewChannel],
	["Read Message History", PermissionFlagsBits.ReadMessageHistory],
	["Send Messages", PermissionFlagsBits.SendMessages],
	["Add Reactions", PermissionFlagsBits.AddReactions],
] as const;

function link(
	channelId: string,
	label: string,
	album: { id: string; title: string },
) {
	linkChannel(channelId, label, album);
	triggerHealthCheck();
}

/** Creates a Google Photos album and links the channel to it. */
export async function createAndLinkAlbum(
	channelId: string,
	label: string,
	title: string,
): Promise<GoogleAlbum> {
	const createResponse = await oauth2Client.request<GoogleAlbum>({
		url: "https://photoslibrary.googleapis.com/v1/albums",
		method: "POST",
		headers: { "Content-type": "application/json" },
		data: { album: { title } },
	});
	console.log("Album creation success:", createResponse.data);
	link(channelId, label, { id: createResponse.data.id, title });
	return createResponse.data;
}

const linkedText = (label: string, title: string) =>
	`✅ **#${label}** now uploads to **${title}**. Photos posted here from now on go to that album. For older ones, use \`/upload from\`.`;

export async function execute(
	interaction: ChatInputCommandInteraction | ButtonInteraction,
	/** Set when called from the alert DM, which isn't in the channel. */
	forChannelId?: string,
) {
	const channelId = forChannelId ?? interaction.channelId;
	if (!channelId) return;

	let label = channelLabel(channelId);
	if (!forChannelId) {
		const channel = interaction.channel;
		if (channel && "name" in channel && channel.name) label = channel.name;

		const missing = NEEDED.filter(
			([, flag]) => !interaction.appPermissions?.has(flag),
		).map(([name]) => name);
		if (missing.length) {
			await interaction.reply({
				content: `I can't upload from **#${label}** yet. Give me these permissions here first: ${missing.join(", ")}.`,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}
	}

	let getResponse: { data: GetAlbumsResponse };
	try {
		getResponse = await oauth2Client.request<GetAlbumsResponse>({
			url: "https://photoslibrary.googleapis.com/v1/albums?pageSize=50",
			method: "GET",
		});
	} catch (error) {
		await interaction.reply({
			content: `Couldn't load albums from Google Photos (${describeError(error)}). Check /status.`,
			flags: MessageFlags.Ephemeral,
		});
		return;
	}

	// A select menu holds at most 25 options.
	const albumsArray = (getResponse.data.albums || []).slice(0, 25);

	const current = getAlbum(channelId);
	const currentAlbumId = current?.id;

	const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];

	rows.push(
		new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder()
				.setCustomId("create")
				.setLabel("Create new album")
				.setStyle(ButtonStyle.Primary),
		),
	);

	if (albumsArray.length) {
		const selectAlbum = new StringSelectMenuBuilder()
			.setCustomId("select")
			.setPlaceholder("Or pick an existing album")
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
		content: current
			? `**#${label}** uploads to **${current.title}**. Pick a different album:`
			: `Link **#${label}** to a Google Photos album. Every photo posted here from now on gets uploaded to it.`,
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
				.setPlaceholder("Album name")
				.setValue(label.slice(0, 100));
			const albumNameLabel = new LabelBuilder()
				.setLabel("Album Name")
				.setDescription(`New Google Photos album for #${label}`)
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

			await createAndLinkAlbum(channelId, label, albumName);

			await interaction.editReply({
				content: linkedText(label, albumName),
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
				link(channelId, label, { id: selectedAlbumId, title: albumTitle });
			}

			await confirmation.update({
				content: linkedText(label, albumTitle),
				components: [],
			});
		} else if (confirmation.customId === "cancel") {
			await confirmation.update({
				content: "Cancelled, nothing changed.",
				components: [],
			});
		}
	} catch (error) {
		console.error(error);

		await interaction.editReply({
			content: "Timed out, nothing changed.",
			components: [],
		});
	}
}

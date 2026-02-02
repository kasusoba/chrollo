import {
	type ChatInputCommandInteraction,
	Colors,
	EmbedBuilder,
	MessageFlags,
	SlashCommandBuilder,
} from "discord.js";
import { type Album, getValidatedAlbum, uploadPhotos } from "../../utils.js";

export const data = new SlashCommandBuilder()
	.setName("upload")
	.setDescription("Upload existing photos in a channel.")
	.addSubcommand((subcommand) =>
		subcommand
			.setName("id")
			.setDescription("Upload only this message id attachment")
			.addStringOption((option) =>
				option
					.setName("message_id")
					.setDescription("The message id to upload attachments from")
					.setRequired(true),
			),
	)
	.addSubcommand((subcommand) =>
		subcommand
			.setName("until")
			.setDescription(
				"Upload all messages STARTING from this ID up to the latest",
			)
			.addStringOption((option) =>
				option
					.setName("message_id")
					.setDescription("The message id to start uploading from")
					.setRequired(true),
			),
	)
	.addSubcommand((subcommand) =>
		subcommand
			.setName("range")
			.setDescription("Upload attachments in a range of message ids")
			.addStringOption((option) =>
				option
					.setName("start_message_id")
					.setDescription("The message id to start uploading attachments from")
					.setRequired(true),
			)
			.addStringOption((option) =>
				option
					.setName("end_message_id")
					.setDescription("The message id to stop uploading attachments at")
					.setRequired(true),
			),
	);

export async function execute(interaction: ChatInputCommandInteraction) {
	const MAX_ALLOWED_MESSAGES_FETCH = 100;
	const subcommand = interaction.options.getSubcommand();

	let album: Album;
	try {
		album = await getValidatedAlbum();
	} catch (error) {
		await interaction.reply({
			content: error instanceof Error ? error.message : "Album error",
			ephemeral: true,
		});
		return;
	}
	const albumId = album.id;

	await interaction.deferReply({
		flags: MessageFlags.Ephemeral,
	});

	let totalUploaded = 0;
	let totalScanned = 0;
	let lastUpdateTimestamp = 0;

	const updateProgress = async (status: string, force = false) => {
		const now = Date.now();

		if (!force && now - lastUpdateTimestamp < 2000) return;

		lastUpdateTimestamp = now;

		const embed = new EmbedBuilder()
			.setTitle(`📷 Uploading to: ${album.title}`)
			.setColor(Colors.Blue)
			.setDescription(status)
			.addFields(
				{ name: "Messages Scanned", value: `${totalScanned}`, inline: true },
				{ name: "Photos Uploaded", value: `${totalUploaded}`, inline: true },
			)
			.setFooter({ text: "Please wait while the bot processes images..." });

		await interaction.editReply({ content: "", embeds: [embed] });
	};

	switch (subcommand) {
		case "id": {
			try {
				await updateProgress("Fetching message...");
				const messageId = interaction.options.getString("message_id", true);
				const message = await interaction.channel?.messages.fetch(messageId);

				if (!message) {
					await interaction.editReply({
						content: `❌ Message with ID ${messageId} not found.`,
						embeds: [],
					});
					return;
				}

				if (message.author.bot || message.attachments.size === 0) {
					await interaction.editReply({
						content: `❌ Message ${messageId} is either from a bot or has no attachments.`,
						embeds: [],
					});
					return;
				}

				const forwardedAttachments = message.messageSnapshots.size
					? Array.from(message.messageSnapshots.values()).flatMap((snapshot) =>
							Array.from(snapshot.attachments.values()),
						)
					: [];

				await updateProgress("Uploading photo...");
				const uploadResponse = await uploadPhotos(
					Array.from(message.attachments.values()).concat(forwardedAttachments),
					albumId,
					{
						uploaderName: message.author.username,
						uploaderDisplayName:
							message.author.displayName || message.author.username,
						uploadTimestamp: message.createdTimestamp,
					},
				);

				const successEmbed = new EmbedBuilder()
					.setTitle("✅ Upload Complete")
					.setColor(Colors.Green)
					.setDescription(
						`Successfully uploaded **${uploadResponse.numOfUploaded}** images to Google Photos album **${album.title}**!`,
					);

				await interaction.editReply({ content: "", embeds: [successEmbed] });
			} catch (error) {
				console.error("Error uploading photos:", error);
				await interaction.editReply(
					`❌ Error: ${error instanceof Error ? error.message : "Unknown error"}`,
				);
			}

			break;
		}

		case "until": {
			const messageId = interaction.options.getString("message_id", true);
			const selectedMessage =
				await interaction.channel?.messages.fetch(messageId);

			if (!selectedMessage) {
				await interaction.editReply(
					`❌ Message with ID ${messageId} not found.`,
				);
				return;
			}

			await updateProgress("Starting batch process...");

			let i = 0;
			let messageIdPointer = messageId;

			while (true) {
				const messages = await interaction.channel?.messages.fetch({
					after: messageIdPointer,
					limit: MAX_ALLOWED_MESSAGES_FETCH,
				});

				if (!messages || messages.size === 0) {
					break;
				}

				// If it's the very first loop, include the starting message manually
				if (i === 0) {
					messages.set(selectedMessage.id, selectedMessage);
				}

				totalScanned += messages.size;

				await updateProgress("🔍 Scanning messages and uploading...");

				const messagesWithAttachments = messages.filter(
					(msg) =>
						!msg.author.bot &&
						(msg.attachments.size > 0 ||
							(msg.messageSnapshots.size > 0 &&
								(msg.messageSnapshots.first()?.attachments?.size ?? 0) > 0)),
				);

				for (const msg of messagesWithAttachments.values()) {
					const attachmentsToUpload = Array.from(msg.attachments.values());
					const forwardedAttachments = msg.messageSnapshots.size
						? Array.from(msg.messageSnapshots.values()).flatMap((snapshot) =>
								Array.from(snapshot.attachments.values()),
							)
						: [];
					attachmentsToUpload.push(...forwardedAttachments);

					try {
						const uploadResponse = await uploadPhotos(
							attachmentsToUpload,
							albumId,
							{
								uploaderName: msg.author.username,
								uploaderDisplayName:
									msg.author.displayName || msg.author.username,
								uploadTimestamp: msg.createdTimestamp,
							},
						);
						totalUploaded += uploadResponse.numOfUploaded;

						await updateProgress("🚀 Uploading found images...");
					} catch (error) {
						console.error(
							`Error uploading photos from message ID ${msg.id}:`,
							error,
						);
					}
				}

				const newestMessageInBatch = messages.first();
				if (!newestMessageInBatch) break;
				messageIdPointer = newestMessageInBatch.id;

				await updateProgress("🔍 Scanning next batch...");
				i += 1;
			}

			const doneEmbed = new EmbedBuilder()
				.setTitle("✅ Batch Upload Complete")
				.setColor(Colors.Green)
				.setDescription(`Process finished for album **${album.title}**.`)
				.addFields(
					{ name: "Total Scanned", value: `${totalScanned}`, inline: true },
					{ name: "Total Uploaded", value: `${totalUploaded}`, inline: true },
				);

			await interaction.editReply({ content: "", embeds: [doneEmbed] });
			break;
		}

		case "range": {
			const startMessageId = interaction.options.getString(
				"start_message_id",
				true,
			);
			const endMessageId = interaction.options.getString(
				"end_message_id",
				true,
			);

			await updateProgress("Locating start/end messages...");

			const startMessage =
				await interaction.channel?.messages.fetch(startMessageId);
			const endMessage =
				await interaction.channel?.messages.fetch(endMessageId);

			if (!startMessage || !endMessage) {
				await interaction.editReply(
					"❌ One or both messages could not be found.",
				);
				return;
			}

			// Normalize: Ensure we know which is older and which is newer
			let olderMessage: typeof startMessage;
			let newerMessage: typeof endMessage;

			if (startMessage.createdTimestamp > endMessage.createdTimestamp) {
				newerMessage = startMessage;
				olderMessage = endMessage;
			} else {
				newerMessage = endMessage;
				olderMessage = startMessage;
			}

			const olderMessageId = olderMessage.id;
			const newerTimestamp = newerMessage.createdTimestamp;

			let i = 0;
			let messageIdPointer = olderMessageId;
			let finished = false;

			await updateProgress("Starting range scan...");

			while (!finished) {
				const messages = await interaction.channel?.messages.fetch({
					after: messageIdPointer,
					limit: MAX_ALLOWED_MESSAGES_FETCH,
				});

				if (!messages || messages.size === 0) {
					break;
				}

				if (i === 0) {
					messages.set(olderMessage.id, olderMessage);
				}

				const validMessages = messages.filter((msg) => {
					return (
						!msg.author.bot &&
						(msg.attachments.size > 0 ||
							(msg.messageSnapshots.size > 0 &&
								(msg.messageSnapshots.first()?.attachments?.size ?? 0) > 0)) &&
						msg.createdTimestamp <= newerTimestamp
					);
				});

				await updateProgress("🔍 Scanning messages and uploading...");

				for (const msg of validMessages.values()) {
					try {
						const forwardedAttachments = msg.messageSnapshots.size
							? Array.from(msg.messageSnapshots.values()).flatMap((snapshot) =>
									Array.from(snapshot.attachments.values()),
								)
							: [];
						const res = await uploadPhotos(
							Array.from(msg.attachments.values()).concat(forwardedAttachments),
							albumId,
							{
								uploaderName: msg.author.username,
								uploaderDisplayName:
									msg.author.displayName || msg.author.username,
								uploadTimestamp: msg.createdTimestamp,
							},
						);
						totalUploaded += res.numOfUploaded;
						await updateProgress("🚀 Uploading in range...");
					} catch (error) {
						console.error(`Error uploading msg ${msg.id}:`, error);
					}
				}

				const newestMessageInBatch = messages.first();
				if (!newestMessageInBatch) break;

				if (newestMessageInBatch.createdTimestamp >= newerTimestamp) {
					finished = true;
				} else {
					messageIdPointer = newestMessageInBatch.id;
				}

				await updateProgress("🔍 Scanning next batch...");
				i += 1;
			}

			const rangeDoneEmbed = new EmbedBuilder()
				.setTitle("✅ Range Upload Complete")
				.setColor(Colors.Green)
				.setDescription(`Range processing finished for **${album.title}**.`)
				.addFields(
					{ name: "Messages Scanned", value: `${totalScanned}`, inline: true },
					{ name: "Photos Uploaded", value: `${totalUploaded}`, inline: true },
				);

			await interaction.editReply({ content: "", embeds: [rangeDoneEmbed] });

			break;
		}
	}
}

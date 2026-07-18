import {
	type ChatInputCommandInteraction,
	type Collection,
	Colors,
	EmbedBuilder,
	InteractionContextType,
	type Message,
	MessageFlags,
	type SendableChannels,
	SlashCommandBuilder,
	type TextBasedChannel,
} from "discord.js";
import {
	type Album,
	getMessageAttachments,
	getUploadedMessageIdsInAlbum,
	getValidatedAlbum,
	hasUploadableAttachments,
	OPERATING_CHANNEL_ID,
	uploadPhotos,
} from "../../utils.js";

const MAX_ALLOWED_MESSAGES_FETCH = 100;

export const data = new SlashCommandBuilder()
	.setName("upload")
	.setDescription("Upload existing photos in a channel.")
	.setContexts([InteractionContextType.Guild, InteractionContextType.BotDM])
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
	const subcommand = interaction.options.getSubcommand();

	// Acknowledge the interaction first. Album validation and the channel fetch
	// below hit the network (and may retry for several seconds), which can blow
	// past Discord's ~3s response window and invalidate the interaction (10062).
	await interaction.deferReply({
		flags: MessageFlags.Ephemeral,
	});

	let album: Album;
	try {
		album = await getValidatedAlbum();
	} catch (error) {
		await interaction.editReply({
			content: error instanceof Error ? error.message : "Album error",
		});
		return;
	}
	const albumId = album.id;

	// Always operate on the omoide channel, even when invoked from a DM.
	const targetChannel =
		await interaction.client.channels.fetch(OPERATING_CHANNEL_ID);
	if (
		!targetChannel ||
		!targetChannel.isTextBased() ||
		!targetChannel.isSendable()
	) {
		await interaction.editReply({
			content: "Could not access the omoide channel.",
		});
		return;
	}

	// Explicit annotation: narrowing from the guard above is lost inside the nested closures below.
	const channel: TextBasedChannel & SendableChannels = targetChannel;

	// The album is the dedup source of truth since it's shared across every machine the bot runs on.
	const uploadedMessageIds = await getUploadedMessageIdsInAlbum(albumId);

	let totalUploaded = 0;
	let totalScanned = 0;
	let totalSkipped = 0;
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

	const uploadMessagePhotos = (message: Message) =>
		uploadPhotos(getMessageAttachments(message), albumId, {
			uploaderName: message.author.username,
			uploaderDisplayName:
				message.author.displayName || message.author.username,
			uploadTimestamp: message.createdTimestamp,
			messageId: message.id,
		});

	const postCompletion = async (embed: EmbedBuilder) => {
		await channel.send({ embeds: [embed] });
		await interaction.editReply({
			content: "✅ Done, posted to the channel.",
			embeds: [],
		});
	};

	// Paginates forward from `anchor` (inclusive); stops after yielding the batch `shouldStop` flags.
	async function* fetchMessageBatches(
		anchor: Message,
		shouldStop?: (messages: Collection<string, Message>) => boolean,
	) {
		let i = 0;
		let pointer = anchor.id;

		while (true) {
			const messages = await channel.messages.fetch({
				after: pointer,
				limit: MAX_ALLOWED_MESSAGES_FETCH,
			});

			if (!messages || messages.size === 0) return;

			// If it's the very first loop, include the anchor message manually.
			if (i === 0) {
				messages.set(anchor.id, anchor);
			}

			yield messages;

			const newestMessageInBatch = messages.first();
			if (!newestMessageInBatch || shouldStop?.(messages)) return;

			pointer = newestMessageInBatch.id;
			i += 1;
		}
	}

	switch (subcommand) {
		case "id": {
			try {
				await updateProgress("Fetching message...");
				const messageId = interaction.options.getString("message_id", true);
				const message = await channel.messages.fetch(messageId);

				if (!message) {
					await interaction.editReply({
						content: `❌ Message with ID ${messageId} not found.`,
						embeds: [],
					});
					return;
				}

				if (!hasUploadableAttachments(message)) {
					await interaction.editReply({
						content: `❌ Message ${messageId} is either from a bot or has no attachments.`,
						embeds: [],
					});
					return;
				}

				if (uploadedMessageIds.has(message.id)) {
					await interaction.editReply({
						content: `⏭️ Message ${messageId} is already in **${album.title}**, skipping.`,
						embeds: [],
					});
					return;
				}

				await updateProgress("Uploading photo...");
				const uploadResponse = await uploadMessagePhotos(message);

				const successEmbed = new EmbedBuilder()
					.setTitle("✅ Upload Complete")
					.setColor(Colors.Green)
					.setDescription(
						`Successfully uploaded **${uploadResponse.numOfUploaded}** images to Google Photos album **${album.title}**!`,
					);

				await postCompletion(successEmbed);
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
			const selectedMessage = await channel.messages.fetch(messageId);

			if (!selectedMessage) {
				await interaction.editReply(
					`❌ Message with ID ${messageId} not found.`,
				);
				return;
			}

			await updateProgress("Starting batch process...");

			for await (const messages of fetchMessageBatches(selectedMessage)) {
				totalScanned += messages.size;

				await updateProgress("🔍 Scanning messages and uploading...");

				const messagesWithAttachments = messages.filter(
					hasUploadableAttachments,
				);

				const newMessages = messagesWithAttachments.filter(
					(msg) => !uploadedMessageIds.has(msg.id),
				);
				totalSkipped += messagesWithAttachments.size - newMessages.size;

				for (const msg of newMessages.values()) {
					try {
						const uploadResponse = await uploadMessagePhotos(msg);
						totalUploaded += uploadResponse.numOfUploaded;

						await updateProgress("🚀 Uploading found images...");
					} catch (error) {
						console.error(
							`Error uploading photos from message ID ${msg.id}:`,
							error,
						);
					}
				}

				await updateProgress("🔍 Scanning next batch...");
			}

			const doneEmbed = new EmbedBuilder()
				.setTitle("✅ Batch Upload Complete")
				.setColor(Colors.Green)
				.setDescription(`Process finished for album **${album.title}**.`)
				.addFields(
					{ name: "Total Scanned", value: `${totalScanned}`, inline: true },
					{ name: "Total Uploaded", value: `${totalUploaded}`, inline: true },
					{
						name: "Already Uploaded (skipped)",
						value: `${totalSkipped}`,
						inline: true,
					},
				);

			await postCompletion(doneEmbed);
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

			const startMessage = await channel.messages.fetch(startMessageId);
			const endMessage = await channel.messages.fetch(endMessageId);

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

			const newerTimestamp = newerMessage.createdTimestamp;
			const reachedEnd = (messages: Collection<string, Message>) =>
				(messages.first()?.createdTimestamp ?? 0) >= newerTimestamp;

			await updateProgress("Starting range scan...");

			for await (const messages of fetchMessageBatches(
				olderMessage,
				reachedEnd,
			)) {
				totalScanned += messages.size;

				const validMessages = messages.filter(
					(msg) =>
						hasUploadableAttachments(msg) &&
						msg.createdTimestamp <= newerTimestamp,
				);

				const newMessages = validMessages.filter(
					(msg) => !uploadedMessageIds.has(msg.id),
				);
				totalSkipped += validMessages.size - newMessages.size;

				await updateProgress("🔍 Scanning messages and uploading...");

				for (const msg of newMessages.values()) {
					try {
						const uploadResponse = await uploadMessagePhotos(msg);
						totalUploaded += uploadResponse.numOfUploaded;
						await updateProgress("🚀 Uploading in range...");
					} catch (error) {
						console.error(`Error uploading msg ${msg.id}:`, error);
					}
				}

				await updateProgress("🔍 Scanning next batch...");
			}

			const rangeDoneEmbed = new EmbedBuilder()
				.setTitle("✅ Range Upload Complete")
				.setColor(Colors.Green)
				.setDescription(`Range processing finished for **${album.title}**.`)
				.addFields(
					{ name: "Messages Scanned", value: `${totalScanned}`, inline: true },
					{ name: "Photos Uploaded", value: `${totalUploaded}`, inline: true },
					{
						name: "Already Uploaded (skipped)",
						value: `${totalSkipped}`,
						inline: true,
					},
				);

			await postCompletion(rangeDoneEmbed);

			break;
		}
	}
}

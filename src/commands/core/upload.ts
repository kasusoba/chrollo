import {
	type ChatInputCommandInteraction,
	SlashCommandBuilder,
} from "discord.js";
import { getAlbum, uploadPhotos } from "../../utils.js";

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
			.setDescription("Upload from latest to oldest until the message id")
			.addStringOption((option) =>
				option
					.setName("message_id")
					.setDescription("The message id to stop uploading attachments at")
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

	const album = getAlbum();
	const albumId = album?.id;

	if (!albumId) {
		interaction.reply(
			"No album selected. Please select an album using /album before uploading.",
		);
		return;
	}

	await interaction.deferReply();

	switch (subcommand) {
		case "id": {
			try {
				const messageId = interaction.options.getString("message_id", true);
				const message = await interaction.channel?.messages.fetch(messageId);

				if (!message) {
					interaction.followUp(`Message with ID ${messageId} not found.`);
					return;
				}

				if (message.attachments.size === 0) {
					interaction.followUp(
						`No attachments found in message with ID ${messageId}.`,
					);
					return;
				}

				const uploadResponse = await uploadPhotos(
					Array.from(message.attachments.values()),
					albumId,
				);
				interaction.followUp(
					`Successfully uploaded **${uploadResponse.numOfUploaded}** images to Google Photos album **${album?.title}**!`,
				);
			} catch (error) {
				console.error("Error uploading photos:", error);
				interaction.followUp(
					error instanceof Error ? error.message : "Unknown error",
				);
			}

			break;
		}
		case "until": {
			const messageId = interaction.options.getString("message_id", true);
			// loop through messages from latest to oldest until messageId
			//		[1a cont] check if message id is in uploaded list, if so skip
			//		add attachments to upload queue / should we upload immediately?
			//		if upload immediately, after upload add message id to uploaded list to avoid duplicates. (ds: nested object json: channelId -> keys of messageIds so it's fast to check o(1)) [1a]
			//		what if queue? i feel like it's not the way, because if we have queue won't we have double the loop?
			//		stop when messageId is reached

			// after all uploads, save uploaded list to file
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

			// same logic as until but with start and end?

			break;
		}
	}
}

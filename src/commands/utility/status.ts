import {
	type ButtonInteraction,
	type ChatInputCommandInteraction,
	InteractionContextType,
	MessageFlags,
	SlashCommandBuilder,
} from "discord.js";
import { getQueueSummary } from "../../autoUpload.js";
import { type Check, getHealthState, runHealthCheck } from "../../health.js";
import { getAuthUrl } from "../../utils.js";

const icon = (check: Check) =>
	check.state === "ok" ? "✅" : check.state === "fail" ? "❌" : "➖";

// Discord renders <t:unix:R> as "5 minutes ago" in the viewer's own timezone.
const ago = (ms: number) => `<t:${Math.floor(ms / 1000)}:R>`;

const status = {
	cooldown: 5,
	data: new SlashCommandBuilder()
		.setName("status")
		.setDescription("Check if the bot is healthy: Google, auth, album.")
		.setContexts([InteractionContextType.Guild, InteractionContextType.BotDM]),
	async execute(interaction: ChatInputCommandInteraction | ButtonInteraction) {
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		const report = await runHealthCheck();
		const { lastReport, lastUpload, lastUploadError } = getHealthState();

		const lines = [
			`✅ Discord: connected (${interaction.client.ws.ping}ms)`,
			`${icon(report.google)} Google: ${report.google.detail}`,
			`${icon(report.auth)} Auth: ${report.auth.detail}`,
			`${icon(report.album)} Album: ${report.album.detail}`,
			"",
			lastUpload
				? `Last upload: ${lastUpload.count} file(s) ${ago(lastUpload.at)}`
				: "Last upload: none since boot",
		];
		if (
			lastUploadError &&
			(!lastUpload || lastUploadError.at > lastUpload.at)
		) {
			lines.push(
				`Last upload failure: ${ago(lastUploadError.at)}: ${lastUploadError.error}`,
			);
		}
		const queued = getQueueSummary();
		if (queued.files && queued.oldest) {
			lines.push(
				`${"⏳"} Waiting to upload: ${queued.files} file(s) from ${queued.messages} message(s), oldest ${ago(queued.oldest)}`,
			);
		}
		if (lastReport) {
			lines.push(`Last background check: ${ago(lastReport.checkedAt)}`);
		}
		if (report.auth.state === "fail") {
			lines.push("", `Log in: ${getAuthUrl()}`);
		}

		await interaction.editReply(lines.join("\n"));
	},
};

export default status;

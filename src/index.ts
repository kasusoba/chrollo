import { Client, Collection, GatewayIntentBits } from "discord.js";
import "dotenv/config";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { google } from "googleapis";
import express from "express";
import session from "express-session";

const EXT = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TOKEN_PATH = path.join(__dirname, "tokens.json");

// Oauth express

export const oauth2Client = new google.auth.OAuth2(
	process.env.GOOGLE_CLIENT_ID,
	process.env.GOOGLE_CLIENT_SECRET,
	process.env.GOOGLE_REDIRECT_URI,
);

const scopes = ["https://www.googleapis.com/auth/photoslibrary.appendonly"];

if (fs.existsSync(TOKEN_PATH)) {
	const savedTokens = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
	oauth2Client.setCredentials(savedTokens);
	console.log("[GOOGLE] Loaded credentials from tokens.json");
} else {
	console.log(
		"[GOOGLE] No tokens found. You must authenticate via the Web Server.",
	);
}

const app = express();

app.use(
	session({
		secret: process.env.SESSION_SECRET || "araranjing",
		resave: false,
		saveUninitialized: false,
	}),
);

app.get("/", async (req, res) => {
	return res.send("kararanjut");
});

app.get("/auth", async (req, res) => {
	const oauthState = Buffer.from(
		crypto.getRandomValues(new Uint8Array(32)),
	).toString("hex");

	req.session.oauthState = oauthState;

	const authUrl = oauth2Client.generateAuthUrl({
		access_type: "offline",
		scope: scopes,
		state: oauthState,
		include_granted_scopes: true,
	});

	return res.redirect(authUrl);
});

app.get("/auth/callback", async (req, res) => {
	const urlObj = new URL(req.url, `http://${req.headers.host}`);
	const params = urlObj.searchParams;

	const error = params.get("error");
	const state = params.get("state");
	const code = params.get("code");

	if (error) {
		console.log("error", error);
		return res.send(`Error: ${error}`);
	} else if (state !== req.session.oauthState) {
		console.log("state mismatch", state, req.session.oauthState);
		return res.send("Error: State mismatch");
	} else {
		if (!code) {
			return res.send("Error: No code provided");
		}

		const { tokens } = await oauth2Client.getToken(code);
		oauth2Client.setCredentials(tokens);

		if (tokens.refresh_token || tokens.access_token) {
			let currentData = {};
			if (fs.existsSync(TOKEN_PATH)) {
				currentData = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
			}

			const newData = { ...currentData, ...tokens };
			fs.writeFileSync(TOKEN_PATH, JSON.stringify(newData, null, 2));
			console.log("[GOOGLE] Tokens saved to disk.");

			return res.send(
				"Authorization successful! You can now use the bot's features.",
			);
		} else {
			return res.send("mana token nya bangsat.");
		}
	}
});

app.listen(3000, () => {
	console.log("OAuth2 server listening on port 3000");
});

// Discord Bot

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
	],
});

client.cooldowns = new Collection();
client.commands = new Collection();

const foldersPath = path.join(__dirname, "commands");
const commandFolders = fs.readdirSync(foldersPath);

for (const folder of commandFolders) {
	const commandsPath = path.join(foldersPath, folder);
	const commandFiles = fs
		.readdirSync(commandsPath)
		.filter((file) => file.endsWith(EXT));

	for (const file of commandFiles) {
		const filePath = path.join(commandsPath, file);

		const commandModule = await import(filePath);
		const command = commandModule.default ?? commandModule;

		if ("data" in command && "execute" in command) {
			client.commands.set(command.data.name, command);
		} else {
			console.log(`mana data sama execute nya brok di ${filePath}`);
		}
	}
}

const eventsPath = path.join(__dirname, "events");
const eventFiles = fs
	.readdirSync(eventsPath)
	.filter((file) => file.endsWith(EXT));

for (const file of eventFiles) {
	const filePath = path.join(eventsPath, file);

	const commandModule = await import(filePath);
	const event = commandModule.default ?? commandModule;

	if (event.once) {
		client.once(event.name, (...args) => event.execute(...args));
	} else {
		client.on(event.name, (...args) => event.execute(...args));
	}
}

client.login(process.env.DISCORD_TOKEN);

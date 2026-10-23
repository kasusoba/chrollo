import { Client, Collection, GatewayIntentBits } from "discord.js";
import "dotenv/config";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import session from "express-session";
import { oauth2Client, TOKEN_PATH } from "./googleClient.js";
import { triggerHealthCheck } from "./health.js";

// Node races IPv4/IPv6 and drops each attempt after 250ms by default. When the
// link to Google is slow (500ms+ connects seen on the Pi), every attempt gets
// dropped and requests fail with ETIMEDOUT. Give each attempt more time.
net.setDefaultAutoSelectFamilyAttemptTimeout(2000);

const EXT = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Oauth express

const scopes = [
	"https://www.googleapis.com/auth/photoslibrary.appendonly",
	"https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata",
	"https://www.googleapis.com/auth/photoslibrary.edit.appcreateddata",
];

const app = express();

app.use(
	session({
		secret: process.env.SESSION_SECRET || "araranjing",
		resave: false,
		saveUninitialized: false,
	}),
);

app.get("/", async (_req, res) => {
	return res.send("kararanjut");
});

/**
 * Opened via localhost (on the host itself or through an SSH tunnel)
 * -> call back to localhost. Anything else -> GOOGLE_REDIRECT_URI.
 * Both URIs must be listed in the Google Cloud OAuth client.
 */
function redirectUriFor(req: express.Request): string {
	const localUri = `http://${req.get("host")}/auth/callback`;
	if (req.hostname === "localhost" || req.hostname === "127.0.0.1") {
		return localUri;
	}
	return process.env.GOOGLE_REDIRECT_URI ?? localUri;
}

app.get("/auth", async (req, res) => {
	const oauthState = Buffer.from(
		crypto.getRandomValues(new Uint8Array(32)),
	).toString("hex");

	const redirectUri = redirectUriFor(req);
	req.session.oauthState = oauthState;
	req.session.redirectUri = redirectUri;

	const authUrl = oauth2Client.generateAuthUrl({
		redirect_uri: redirectUri,
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

		const { tokens } = await oauth2Client.getToken({
			code,
			redirect_uri: req.session.redirectUri ?? redirectUriFor(req),
		});
		oauth2Client.setCredentials(tokens);

		if (tokens.refresh_token || tokens.access_token) {
			let currentData = {};
			if (fs.existsSync(TOKEN_PATH)) {
				currentData = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
			}

			const newData = { ...currentData, ...tokens };
			fs.writeFileSync(TOKEN_PATH, JSON.stringify(newData, null, 2));
			console.log("[GOOGLE] Tokens saved to disk.");
			triggerHealthCheck();

			return res.send(
				"Authorization successful! You can now use the bot's features.",
			);
		} else {
			return res.send("mana token nya bangsat.");
		}
	}
});

const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, () => {
	console.log(`OAuth2 server listening on port ${PORT}`);
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

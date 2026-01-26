import fs from "node:fs";
import path from "node:path";
import { google } from "googleapis";

export const TOKEN_PATH = path.join(process.cwd(), "tokens.json");

export const oauth2Client = new google.auth.OAuth2(
	process.env.GOOGLE_CLIENT_ID,
	process.env.GOOGLE_CLIENT_SECRET,
	process.env.GOOGLE_REDIRECT_URI,
);

if (fs.existsSync(TOKEN_PATH)) {
	try {
		const savedTokens = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
		oauth2Client.setCredentials(savedTokens);
		console.log("[GOOGLE] Loaded credentials from tokens.json");
	} catch (e) {
		console.error("[GOOGLE] Error reading tokens.json", e);
	}
} else {
	console.log(
		"[GOOGLE] No tokens found. Authenticate via http://localhost:3000/auth",
	);
}

oauth2Client.on("tokens", (tokens) => {
	console.log("[GOOGLE] Token refreshed automatically!");
	let currentData = {};
	if (fs.existsSync(TOKEN_PATH)) {
		currentData = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
	}
	const newData = { ...currentData, ...tokens };
	fs.writeFileSync(TOKEN_PATH, JSON.stringify(newData, null, 2));
});

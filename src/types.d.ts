import "discord.js";
import "express-session";
import type { Collection } from "discord.js";

declare module "discord.js" {
	interface Client {
		commands: Collection<string, any>;
		cooldowns: Collection<string, any>;
	}
}

declare module "express-session" {
	interface SessionData {
		oauthState?: string;
	}
}

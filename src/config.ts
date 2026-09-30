import { mkdirSync } from "fs";
import { dirname } from "path";

export const PORT = parseInt(process.env.PORT || "3456");
export const DATABASE_PATH = process.env.DATABASE_PATH || "./data/proxy.db";
export const ADMIN_API_SECRET = process.env.ADMIN_API_SECRET || "";
export const AUTH_DISABLED = process.env.AUTH_DISABLED === "true";
// Gateway adapter mode: tools execute at the caller, never inside this proxy.
export const ALLOW_SERVER_SIDE_TOOLS = process.env.ALLOW_SERVER_SIDE_TOOLS === "true";
export const OLLAMA_URL = process.env.OLLAMA_URL || "http://ollama:11434";

// Ensure the database directory exists
mkdirSync(dirname(DATABASE_PATH), { recursive: true });

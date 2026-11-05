import { readClaudeCliCredentials } from "./services/claudeCliCredentials.js";
import { publicRefreshStatus } from "./services/authRefreshStatus.js";

const { status } = readClaudeCliCredentials();
console.log(JSON.stringify({ ...status, refresh: process.env.CLAUDE_CONFIG_DIR ? publicRefreshStatus(process.env.CLAUDE_CONFIG_DIR) : null,
  remotely_validated: false }, null, 2));
process.exitCode = status.configured ? 0 : 1;

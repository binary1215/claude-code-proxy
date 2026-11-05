import { readClaudeCliCredentials } from "./services/claudeCliCredentials.js";

const { status } = readClaudeCliCredentials();
console.log(JSON.stringify({ ...status, remotely_validated: false }, null, 2));
process.exitCode = status.configured ? 0 : 1;

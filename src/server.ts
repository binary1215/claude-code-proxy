import { PORT, RESPONSES_ENABLED, CLAUDE_INFERENCE_BACKEND } from "./config.js";
// Importing connection module triggers DB init + migrations
import "./db/connection.js";
import { app } from "./app.js";
import { startAuthRefreshScheduler } from "./services/authRefreshScheduler.js";
import { closeCliSessions } from "./services/cliSessions.js";

const stopAuthRefresh = startAuthRefreshScheduler();
process.once("exit", stopAuthRefresh);

const server = app.listen(PORT, () => {
  console.log(`Claude proxy running on port ${PORT} (${CLAUDE_INFERENCE_BACKEND} inference)`);
  console.log(`  POST http://localhost:${PORT}/v1/messages`);
  console.log(`  POST http://localhost:${PORT}/v1/messages/count_tokens`);
  console.log(`  GET  http://localhost:${PORT}/v1/models`);
  if (RESPONSES_ENABLED) console.log(`  POST http://localhost:${PORT}/v1/responses (stateless adapter)`);
  console.log(`  GET  http://localhost:${PORT}/health`);
  console.log(`  Admin API at http://localhost:${PORT}/api/admin/*`);
});
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => {
  stopAuthRefresh();
  const stopCli = closeCliSessions();
  server.close(() => { void stopCli.finally(() => process.exit(0)); });
  setTimeout(() => process.exit(0), 3000).unref();
});

import { PORT, RESPONSES_ENABLED } from "./config.js";
// Importing connection module triggers DB init + migrations
import "./db/connection.js";
import { app } from "./app.js";

app.listen(PORT, () => {
  console.log(`Native Anthropic relay running on port ${PORT}`);
  console.log(`  POST http://localhost:${PORT}/v1/messages`);
  console.log(`  POST http://localhost:${PORT}/v1/messages/count_tokens`);
  console.log(`  GET  http://localhost:${PORT}/v1/models`);
  if (RESPONSES_ENABLED) console.log(`  POST http://localhost:${PORT}/v1/responses (stateless adapter)`);
  console.log(`  GET  http://localhost:${PORT}/health`);
  console.log(`  Admin API at http://localhost:${PORT}/api/admin/*`);
});

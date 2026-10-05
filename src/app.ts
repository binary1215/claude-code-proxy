import express from "express";
import anthropicRoutes from "./routes/anthropic.js";
import responsesRoutes from "./routes/responses.js";
import embeddingsRoutes from "./routes/embeddings.js";
import adminApiRoutes from "./routes/adminApi.js";
import healthRoutes from "./routes/health.js";
import { apiKeyAuth } from "./middleware/apiKeyAuth.js";
import { rateLimitMiddleware } from "./middleware/rateLimiter.js";
import { nativeConfigurationGuard } from "./middleware/nativeConfigurationGuard.js";
import { errorHandler } from "./middleware/errorHandler.js";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "10mb", inflate: false, verify(req, _res, buffer) {
  (req as express.Request).rawBody = Buffer.from(buffer);
} }));

// Health check — no auth
app.use(healthRoutes);

// Admin API — protected by admin secret
app.use("/api/admin", adminApiRoutes);

// Both protocols share key/model/config policy. Responses is separately opt-in.
app.use("/v1", apiKeyAuth, nativeConfigurationGuard, rateLimitMiddleware);
app.use("/v1", anthropicRoutes);
app.use("/v1", responsesRoutes);
// Embeddings: POST /v1/embeddings (proxied to Ollama)
app.use("/v1", embeddingsRoutes);
app.use("/v1", (_req, res) => {
  res.status(404).json({ type: "error", error: { type: "not_found_error", message: "Unsupported endpoint. This relay supports native Messages and an optional stateless Responses adapter; Chat, stored responses and compaction are not supported." } });
});

// Centralized error handler
app.use(errorHandler);

export { app };

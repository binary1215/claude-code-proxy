import express from "express";
import anthropicRoutes from "./routes/anthropic.js";
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

// LiteLLM owns OpenAI conversions; this backend speaks native Messages only.
app.use("/v1", apiKeyAuth, nativeConfigurationGuard, rateLimitMiddleware);
app.use("/v1", anthropicRoutes);
// Embeddings: POST /v1/embeddings (proxied to Ollama)
app.use("/v1", embeddingsRoutes);
app.use("/v1", (_req, res) => {
  res.status(404).json({ type: "error", error: { type: "not_found_error", message: "Unsupported endpoint. Send Chat/Responses requests to LiteLLM; this backend accepts native Anthropic Messages." } });
});

// Centralized error handler
app.use(errorHandler);

export { app };

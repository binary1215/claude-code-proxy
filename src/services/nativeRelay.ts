import http, { type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { ANTHROPIC_BASE_URL, UPSTREAM_TIMEOUT_MS } from "../config.js";
import { getUpstreamCredential } from "./settingsService.js";
import { insertPendingRequest, completeRequest } from "./historyService.js";
import { registerTask, unregisterTask } from "./taskTracker.js";
import { recordTokensForRateLimit } from "../middleware/rateLimiter.js";
import { UsageObserver } from "./usageObserver.js";
import { logOperationalError } from "./operationalLogger.js";
import { UpstreamDiagnosticsObserver, type DiagnosticReason } from "./upstreamDiagnostics.js";

const HOP_HEADERS = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade"]);

function excludedHeaders(headers: IncomingHttpHeaders): Set<string> {
  return new Set([...HOP_HEADERS, ...(headers.connection || "").split(",").map(v => v.trim().toLowerCase())]);
}

export function upstreamUrl(base: string, path: string, query = ""): URL {
  const url = new URL(base);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Invalid upstream URL");
  }
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "") + "/v1" + path;
  url.search = query;
  return url;
}

export function upstreamHeaders(req: Request, credential: { token: string; kind: "oauth" | "api_key" }): http.OutgoingHttpHeaders {
  const excluded = excludedHeaders(req.headers);
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!excluded.has(name) && (name.startsWith("anthropic-") ||
      ["content-type", "accept", "user-agent", "x-request-id", "x-client-request-id", "idempotency-key"].includes(name))) {
      headers[name] = value;
    }
  }
  headers["anthropic-version"] ??= "2023-06-01";
  headers["accept-encoding"] = "identity";
  if (credential.kind === "oauth") {
    headers.authorization = `Bearer ${credential.token}`;
    const betas = String(headers["anthropic-beta"] || "").split(",").map(s => s.trim()).filter(Boolean);
    if (!betas.includes("oauth-2025-04-20")) betas.push("oauth-2025-04-20");
    headers["anthropic-beta"] = betas.join(",");
  } else headers["x-api-key"] = credential.token;
  return headers;
}

export function relayNative(req: Request, res: Response, endpoint: string): void {
  const credential = getUpstreamCredential();
  if (!credential || /[^\x21-\x7e]/.test(credential.token)) {
    res.status(503).json({ type: "error", error: { type: "api_error", message: "Upstream credential is not configured." } });
    return;
  }
  let url: URL;
  try { url = upstreamUrl(ANTHROPIC_BASE_URL, endpoint, req.originalUrl.split("?").slice(1).join("?")); }
  catch {
    res.status(503).json({ type: "error", error: { type: "api_error", message: "Invalid upstream base URL configuration." } });
    return;
  }
  const headers = upstreamHeaders(req, credential);
  const body = req.method === "POST" ? req.rawBody : undefined;
  if (body) headers["content-length"] = body.length;

  const start = Date.now();
  const id = `msgproxy-${randomUUID()}`;
  const model = typeof req.body?.model === "string" ? req.body.model : "models";
  const streaming = req.body?.stream === true;
  const logId = insertPendingRequest({ apiKeyId: req.apiKeyId ?? null, completionId: id,
    requestedModel: model, resolvedModel: model, isStream: streaming });
  let observer = new UsageObserver(false, false);
  const diagnostics = new UpstreamDiagnosticsObserver(credential.kind);
  let upstream: IncomingMessage | undefined;
  let done = false;
  let ended = false;
  let responseStatus: "success" | "error" = "success";
  let responseIsSse = false;

  const finish = (status: "success" | "error" | "cancelled", reason?: DiagnosticReason) => {
    if (done) return;
    done = true;
    clearTimeout(deadline);
    unregisterTask(id);
    const usage = observer.snapshot();
    try {
      completeRequest(logId, status, { ...usage, usageComplete: status === "success" && usage.usageComplete,
        durationMs: Date.now() - start, errorMessage: status === "error" ? "upstream_error" : undefined,
        diagnostics: diagnostics.snapshot(reason) });
    } catch (error) {
      // A full/unavailable log DB must not crash HTTP event handlers or corrupt delivery.
      logOperationalError("request_history_write_failed", error);
    }
    if (req.apiKeyId && endpoint === "/messages") {
      recordTokensForRateLimit(req.apiKeyId, (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) +
        (usage.cacheCreationInputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0));
    }
  };
  const fail = (reason: DiagnosticReason = "network_error") => {
    if (done) return;
    finish("error", reason);
    if (res.headersSent) res.destroy();
    else res.status(502).json({ type: "error", error: { type: "api_error", message: "Upstream connection failed or timed out." } });
    upstream?.destroy();
    outgoing.destroy();
  };
  const outgoing = (url.protocol === "https:" ? https : http).request(url, {
    method: req.method, headers,
  }, incoming => {
    if (done) { incoming.destroy(); return; }
    upstream = incoming;
    const code = incoming.statusCode || 502;
    diagnostics.receive(code, incoming.headers);
    responseStatus = code >= 200 && code < 300 ? "success" : "error";
    const mime = String(incoming.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    const sse = responseIsSse = mime === "text/event-stream";
    observer = new UsageObserver(sse, !incoming.headers["content-encoding"] || incoming.headers["content-encoding"] === "identity");
    res.status(code);
    const blocked = excludedHeaders(incoming.headers);
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (value !== undefined && !blocked.has(name)) res.setHeader(name, value);
    }
    res.setHeader("x-accel-buffering", "no");
    res.flushHeaders();
    incoming.on("data", (chunk: Buffer) => {
      if (done) return;
      observer.write(chunk);
      diagnostics.write(chunk);
      if (!res.write(chunk)) incoming.pause();
    });
    res.on("drain", () => incoming.resume());
    incoming.on("end", () => {
      if (done) return;
      ended = true;
      observer.end();
      diagnostics.end();
      if (observer.hasError || (sse && observer.canObserve && !observer.streamComplete)) responseStatus = "error";
      res.end();
    });
    incoming.on("error", () => fail());
    incoming.on("aborted", () => fail());
  });
  const deadline = setTimeout(() => fail("timeout"), UPSTREAM_TIMEOUT_MS);
  deadline.unref();
  outgoing.on("error", () => fail());
  const cancel = () => {
    if (done) return;
    finish("cancelled", "cancelled");
    upstream?.destroy();
    outgoing.destroy();
    if (!res.headersSent) res.status(499).json({ type: "error", error: { type: "api_error", message: "Request cancelled." } });
    else res.destroy();
  };
  registerTask({ id, model, promptPreview: "", apiKeyId: req.apiKeyId ?? null,
    apiKeyName: req.apiKeyName ?? null, startedAt: new Date(start).toISOString(),
    isStreaming: streaming, requestLogId: logId }, async () => cancel());
  res.on("finish", () => {
    if (ended) finish(responseStatus, observer.hasError ? "provider_error" : responseStatus === "error" &&
      responseIsSse &&
      observer.canObserve && !observer.streamComplete ? "truncated_stream" : undefined);
  });
  res.on("close", () => { if (!res.writableFinished) cancel(); });
  res.on("error", cancel);
  req.on("aborted", cancel);
  // Node http never follows redirects, retries, decompresses, or reserializes JSON.
  outgoing.end(body);
}

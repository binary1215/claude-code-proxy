import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { Request, Response } from "express";
import { ANTHROPIC_BASE_URL, UPSTREAM_TIMEOUT_MS, RESPONSES_ENABLED, RESPONSES_STATE_KEY,
  RESPONSES_STATE_TTL_SECONDS, RESPONSES_MAX_OUTPUT_TOKENS, RESPONSES_THINKING_BUDGET_TOKENS, RESPONSES_APPLY_PATCH_MODE } from "../config.js";
import { getUpstreamCredential } from "./settingsService.js";
import { upstreamHeaders, upstreamUrl } from "./nativeRelay.js";
import { ResponsesStateCodec, upstreamStateScope } from "./responsesState.js";
import { prepareResponsesRequest } from "./responsesRequest.js";
import { ResponsesStream, NativeSseDecoder, convertNativeMessage } from "./responsesStream.js";
import { ResponsesError, type JsonObject, type PreparedResponsesRequest, type ResponseTranslationOptions } from "./responsesTypes.js";
import { UsageObserver } from "./usageObserver.js";
import { UpstreamDiagnosticsObserver, type DiagnosticReason } from "./upstreamDiagnostics.js";
import { insertPendingRequest, completeRequest } from "./historyService.js";
import { registerTask, unregisterTask } from "./taskTracker.js";
import { recordTokensForRateLimit } from "../middleware/rateLimiter.js";
import { logOperationalError } from "./operationalLogger.js";

// Configuration is validated at startup only when explicitly opted in.
const codec = RESPONSES_ENABLED ? new ResponsesStateCodec(RESPONSES_STATE_KEY, RESPONSES_STATE_TTL_SECONDS) : null;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { type: status < 500 ? "invalid_request_error" : "api_error", code, message } });
}

/** One direct native provider request; no SDK, tool execution, retry or model fallback. */
export function relayResponses(req: Request, res: Response): void {
  const credential = getUpstreamCredential();
  if (!codec || !credential || /[^\x21-\x7e]/.test(credential.token)) {
    sendError(res, 503, "upstream_not_configured", "Responses adapter credentials are not configured.");
    return;
  }
  let prepared: PreparedResponsesRequest;
  let url: URL;
  let options: ResponseTranslationOptions;
  try {
    if (req.originalUrl.includes("?")) throw new ResponsesError("unsupported_parameter", "Query parameters are not supported on the Responses adapter.");
    const model = req.body?.model;
    if (typeof model !== "string" || !model.trim() || model.length > 256) {
      throw new ResponsesError("invalid_model", "A native model ID is required.");
    }
    if (req.allowedModels?.length && !req.allowedModels.includes(model)) {
      throw new ResponsesError("model_not_allowed", "Model is not permitted for this key.", 403);
    }
    url = upstreamUrl(ANTHROPIC_BASE_URL, "/messages");
    const context = { model, principal: `proxy-key:${req.apiKeyFingerprint ?? "anonymous-development"}`,
      upstream: upstreamStateScope(url.href, credential) };
    // Explicit per-request native policy for clients that can set HTTP headers but
    // cannot add JSON extension fields. Never mix two conflicting policy sources.
    let input = req.body;
    const nativeOptions = req.headers["x-claude-proxy-native-options"];
    if (nativeOptions !== undefined) {
      if (typeof nativeOptions !== "string" || Buffer.byteLength(nativeOptions) > 4096 ||
          !input || typeof input !== "object" || Array.isArray(input) || Object.hasOwn(input, "anthropic")) {
        throw new ResponsesError("invalid_native_options", "Supply native options once, as a bounded JSON body extension or header.");
      }
      let extension: unknown;
      try { extension = JSON.parse(nativeOptions); }
      catch { throw new ResponsesError("invalid_native_options", "Native options header must be a JSON object."); }
      input = { ...input, anthropic: extension };
    }
    prepared = prepareResponsesRequest(input, { codec, context, defaultMaxTokens: RESPONSES_MAX_OUTPUT_TOKENS,
      defaultThinkingBudget: RESPONSES_THINKING_BUDGET_TOKENS, applyPatchMode: RESPONSES_APPLY_PATCH_MODE });
    options = { model, tools: prepared.tools, seal: (block, id) => codec.seal(block, context, id) };
  } catch (error) {
    if (error instanceof ResponsesError) sendError(res, error.status, error.code, error.message);
    else sendError(res, 503, "adapter_configuration_error", "Responses adapter configuration is invalid.");
    return;
  }
  const body = Buffer.from(JSON.stringify(prepared.nativeBody));
  if (body.length > 10 * 1024 * 1024) {
    sendError(res, 413, "request_too_large", "Translated request exceeds the supported size.");
    return;
  }
  const headers = upstreamHeaders(req, credential);
  headers["content-type"] = "application/json";
  headers.accept = prepared.stream ? "text/event-stream" : "application/json";
  headers["content-length"] = body.length;
  const started = Date.now();
  const taskId = `responsesproxy-${randomUUID()}`;
  const logId = insertPendingRequest({ apiKeyId: req.apiKeyId ?? null, completionId: taskId,
    requestedModel: prepared.model, resolvedModel: prepared.model, isStream: prepared.stream });
  let observer = new UsageObserver(false);
  const diagnostics = new UpstreamDiagnosticsObserver(credential.kind);
  const signal = new AbortController();
  let incoming: IncomingMessage | undefined;
  let converter: ResponsesStream | undefined;
  let finalized = false;
  let responseEnded = false;
  let finalStatus: "success" | "error" = "success";
  let finalReason: DiagnosticReason | undefined;
  let responseBytes = 0;
  let pendingTerminal: JsonObject | undefined;

  const finalize = (status: "success" | "error" | "cancelled", reason?: DiagnosticReason) => {
    if (finalized) return;
    finalized = true;
    clearTimeout(deadline);
    signal.abort();
    unregisterTask(taskId);
    const usage = observer.snapshot();
    try {
      completeRequest(logId, status, { ...usage, usageComplete: status === "success" && usage.usageComplete,
        durationMs: Date.now() - started, errorMessage: status === "error" ? "upstream_error" : undefined,
        diagnostics: diagnostics.snapshot(reason) });
    } catch (error) { logOperationalError("request_history_write_failed", error); }
    if (req.apiKeyId) recordTokensForRateLimit(req.apiKeyId,
      (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0));
  };
  const stopUpstream = () => { incoming?.destroy(); outgoing.destroy(); };
  const write = async (chunk: string | Buffer) => {
    if (finalized || res.destroyed) throw new Error("Response closed");
    if (!res.write(chunk)) await once(res, "drain", { signal: signal.signal });
  };
  const writeEvent = (event: JsonObject) => write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  const fail = (reason: DiagnosticReason = "network_error") => {
    if (finalized) return;
    // Never emit a previously held success terminal after a late parse/transport failure.
    pendingTerminal = undefined;
    finalize("error", reason);
    if (!res.headersSent) sendError(res, 502, "upstream_error", "Upstream response failed, was unsupported, or timed out.");
    else if (converter && !converter.terminal && !res.destroyed) {
      const events = converter.fail("upstream_error", "Upstream response failed.");
      // Bounded final diagnostic only; upstream/body/error text is never interpolated.
      for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    } else res.destroy();
    stopUpstream();
  };

  const handle = async (stream: IncomingMessage) => {
    if (finalized) { stream.destroy(); return; }
    incoming = stream;
    const status = stream.statusCode || 502;
    diagnostics.receive(status, stream.headers);
    const mime = String(stream.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    const identity = !stream.headers["content-encoding"] || stream.headers["content-encoding"] === "identity";
    observer = new UsageObserver(mime === "text/event-stream", identity);
    for (const name of ["request-id", "x-request-id", "retry-after"]) {
      const value = stream.headers[name];
      if (value !== undefined) res.setHeader(name, value);
    }
    if (status < 200 || status >= 300) {
      // Preserve HTTP rejection once. No thinking removal, redirect following or retry.
      finalStatus = "error";
      res.status(status);
      res.setHeader("content-type", stream.headers["content-type"] || "application/json");
      if (stream.headers["content-encoding"]) res.setHeader("content-encoding", stream.headers["content-encoding"]);
      for await (const bytes of stream) {
        if (finalized) return;
        const chunk = Buffer.from(bytes);
        responseBytes += chunk.length;
        if (responseBytes > MAX_RESPONSE_BYTES) throw new Error("Bound exceeded");
        observer.write(chunk); diagnostics.write(chunk); await write(chunk);
      }
      observer.end(); diagnostics.end(); responseEnded = true; res.end(); return;
    }
    if (!identity || (prepared.stream ? mime !== "text/event-stream" : mime !== "application/json")) {
      throw new ResponsesError("unsupported_upstream_format", "Unsupported upstream response encoding or format.", 502);
    }
    if (prepared.stream) {
      converter = new ResponsesStream(options);
      const decoder = new NativeSseDecoder();
      res.status(200).set({ "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" });
      const events = async (nativeEvents: JsonObject[]) => {
        for (const event of nativeEvents) {
          for (const converted of converter!.push(event)) {
            if (converted.type === "response.completed" || converted.type === "response.incomplete") pendingTerminal = converted;
            else await writeEvent(converted);
          }
          if (converter!.terminal && converter!.response.status === "failed") {
            pendingTerminal = undefined;
            finalize("error", "provider_error");
            res.end(); stopUpstream(); return;
          }
        }
      };
      for await (const bytes of stream) {
        if (finalized) return;
        const chunk = Buffer.from(bytes);
        observer.write(chunk); diagnostics.write(chunk);
        await events(decoder.write(chunk));
        if (finalized) return;
      }
      await events(decoder.end());
      if (finalized) return;
      converter.finish();
      if (!pendingTerminal) throw new Error("Missing terminal response");
      observer.end(); diagnostics.end();
      await writeEvent(pendingTerminal);
    } else {
      const chunks: Buffer[] = [];
      for await (const bytes of stream) {
        if (finalized) return;
        const chunk = Buffer.from(bytes);
        responseBytes += chunk.length;
        if (responseBytes > MAX_RESPONSE_BYTES) throw new Error("Bound exceeded");
        chunks.push(chunk); observer.write(chunk); diagnostics.write(chunk);
      }
      observer.end(); diagnostics.end();
      // Invalid bytes cannot be silently replaced inside signed state or text.
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
      const response = convertNativeMessage(JSON.parse(decoded), options);
      if (response.status === "failed") { finalStatus = "error"; finalReason = "provider_error"; }
      responseEnded = true;
      res.status(response.status === "failed" ? 502 : 200).json(response);
      return;
    }
    responseEnded = true;
    res.end();
  };
  const outgoing = (url.protocol === "https:" ? https : http).request(url, { method: "POST", headers }, stream => {
    void handle(stream).catch(() => fail("provider_error"));
  });
  const deadline = setTimeout(() => fail("timeout"), UPSTREAM_TIMEOUT_MS);
  deadline.unref();
  outgoing.on("error", () => fail());
  const cancel = () => {
    if (finalized) return;
    finalize("cancelled", "cancelled");
    stopUpstream();
    if (!res.headersSent && !res.destroyed) sendError(res, 499, "request_cancelled", "Request cancelled.");
    else res.destroy();
  };
  registerTask({ id: taskId, model: prepared.model, promptPreview: "", apiKeyId: req.apiKeyId ?? null,
    apiKeyName: req.apiKeyName ?? null, startedAt: new Date(started).toISOString(), isStreaming: prepared.stream,
    requestLogId: logId }, async () => cancel());
  res.on("finish", () => { if (responseEnded) finalize(finalStatus, finalReason); });
  res.on("close", () => { if (!res.writableFinished) cancel(); });
  res.on("error", cancel);
  req.on("aborted", cancel);
  outgoing.end(body);
}

import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { UPSTREAM_TIMEOUT_MS } from "../config.js";
import { resolveUpstreamCredential, missingCredentialMessage } from "./settingsService.js";
import { acquireCliSession } from "./cliSessions.js";
import { CliBackendError } from "./cliProtocol.js";
import { UsageObserver } from "./usageObserver.js";
import { completeRequest, insertPendingRequest } from "./historyService.js";
import { registerTask, unregisterTask } from "./taskTracker.js";
import { recordTokensForRateLimit } from "../middleware/rateLimiter.js";
import { logOperationalError } from "./operationalLogger.js";
import { ResponsesStream, convertNativeMessage } from "./responsesStream.js";
import { ResponsesError, type JsonObject, type ResponseTranslationOptions } from "./responsesTypes.js";
import type { DiagnosticReason, UpstreamDiagnosticsObserver } from "./upstreamDiagnostics.js";

const eventBytes = (event: JsonObject): Buffer => Buffer.from(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
export async function writeCliBytes(res: Response, bytes: Buffer, signal?: AbortSignal): Promise<void> {
  if (res.destroyed || signal?.aborted) throw new CliBackendError("request_cancelled", "Request cancelled.", 499);
  if (!res.write(bytes)) await new Promise<void>((resolve, reject) => {
    const done = () => { cleanup(); resolve(); }, closed = () => { cleanup(); reject(new Error("closed")); };
    const aborted = () => { cleanup(); reject(new CliBackendError("request_cancelled", "Request cancelled.", 499)); };
    const cleanup = () => { res.off("drain", done); res.off("close", closed); signal?.removeEventListener("abort", aborted); };
    res.once("drain", done); res.once("close", closed);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

/** A state-owning optional backend. The default native HTTP path does not enter here. */
export async function relayCli(req: Request, res: Response, nativeBody: JsonObject,
  responseOptions?: ResponseTranslationOptions,
  configuredCredential?: { token: string; kind: "oauth" | "api_key"; stateIdentity?: string }): Promise<void> {
  const started = Date.now(), id = `cliproxy-${randomUUID()}`, model = nativeBody.model;
  const streaming = nativeBody.stream === true;
  const observer = new UsageObserver(true);
  const controller = new AbortController();
  let timedOut = false, cancelled = false;
  let status: "success" | "error" | "cancelled" = "error";
  let reason: DiagnosticReason = "provider_error";
  let lease: Awaited<ReturnType<typeof acquireCliSession>> | undefined;
  let converter: ResponsesStream | undefined;
  let terminal: JsonObject | undefined;
  let upstreamObserver: UpstreamDiagnosticsObserver | undefined;
  const logId = insertPendingRequest({ apiKeyId: req.apiKeyId ?? null, completionId: id,
    requestedModel: model, resolvedModel: model, isStream: streaming });
  const cancel = () => { cancelled = true; controller.abort(); };
  const close = () => { if (!res.writableFinished) cancel(); };
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, UPSTREAM_TIMEOUT_MS);
  timer.unref();
  req.once("aborted", cancel); res.once("close", close);
  registerTask({ id, model, promptPreview: "", apiKeyId: req.apiKeyId ?? null, apiKeyName: req.apiKeyName ?? null,
    startedAt: new Date(started).toISOString(), isStreaming: streaming, requestLogId: logId }, async () => { cancel(); });
  try {
    const credential = configuredCredential ?? await resolveUpstreamCredential(() => res.destroyed || controller.signal.aborted);
    if (!credential) throw new CliBackendError("upstream_not_configured", missingCredentialMessage(), 503);
    lease = await acquireCliSession(nativeBody, `proxy-key:${req.apiKeyFingerprint ?? "anonymous-development"}`, credential, controller.signal);
    res.setHeader("x-claude-proxy-backend", "cli");
    res.setHeader("x-claude-proxy-cli-session", lease.session.id);
    if (streaming && responseOptions) converter = new ResponsesStream(responseOptions);
    for await (const event of lease.session.events()) {
      const bytes = eventBytes(event);
      observer.write(bytes);
      if (streaming) {
        if (!res.headersSent) res.status(200).set({ "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" });
        if (converter) {
          for (const converted of converter.push(event)) {
            if (["response.completed", "response.incomplete", "response.failed"].includes(converted.type)) terminal = converted;
            else await writeCliBytes(res, eventBytes(converted), controller.signal);
          }
        } else if (event.type === "message_stop") terminal = event;
        else await writeCliBytes(res, bytes, controller.signal);
      }
    }
    observer.end();
    upstreamObserver = lease.session.upstream.observer;
    const message = lease.session.message!;
    const converted = !streaming && responseOptions ? convertNativeMessage(message, responseOptions) : undefined;
    if (streaming && !terminal) throw new CliBackendError("incomplete_cli_stream", "The CLI stream has no terminal event.", 502);
    if (converted?.status === "failed" || terminal?.response?.status === "failed") {
      lease.session.close();
    } else {
      // Publish the continuation before exposing the terminal to fast clients.
      lease.session.commit(lease.messages);
      status = "success"; reason = "success";
    }
    if (streaming) { await writeCliBytes(res, eventBytes(terminal!), controller.signal); res.end(); }
    else res.status(200).json(converted ?? message);
  } catch (error) {
    status = cancelled ? "cancelled" : "error";
    reason = timedOut ? "timeout" : cancelled ? "cancelled" : "provider_error";
    const failure = lease?.session.upstream.failure;
    upstreamObserver ??= lease?.session.upstream.observer;
    lease?.session.fail(error instanceof Error ? error : new Error());
    if (!res.destroyed) {
      if (!res.headersSent) {
        if (failure) res.status(failure.status).type(failure.contentType).send(failure.body);
        else {
          const problem = error instanceof CliBackendError || error instanceof ResponsesError ? error :
            new CliBackendError("cli_inference_failed", "The CLI inference request failed.", 502);
          res.status(timedOut ? 504 : cancelled ? 499 : problem.status).json({ type: "error", error: {
            type: timedOut ? "api_error" : problem.status >= 500 ? "api_error" : "invalid_request_error",
            code: timedOut ? "cli_timeout" : problem.code, message: timedOut ? "The CLI request timed out." : problem.message,
          } });
        }
      } else if (controller.signal.aborted) {
        // A connected client may stop reading. Do not await another blocked
        // error write after timeout/task cancellation; finalize owned work now.
        res.destroy();
      } else {
        try {
          const failed = converter?.fail(timedOut ? "upstream_timeout" : cancelled ? "cancelled" : "upstream_error", "") ??
            [{ type: "error", error: { type: "api_error", message: "The CLI request did not complete." } }];
          for (const event of failed) await writeCliBytes(res, eventBytes(event), controller.signal);
          res.end();
        } catch { res.destroy(); }
      }
    }
  } finally {
    clearTimeout(timer); req.off("aborted", cancel); res.off("close", close); lease?.detach();
    observer.end(); unregisterTask(id);
    const usage = observer.snapshot();
    try {
      completeRequest(logId, status, { ...usage, usageComplete: status === "success" && usage.usageComplete,
        durationMs: Date.now() - started, errorMessage: status === "error" ? "upstream_error" : undefined,
        diagnostics: upstreamObserver?.snapshot(reason) ?? { upstream_diagnostic: reason } });
    } catch (error) { logOperationalError("request_history_write_failed", error); }
    if (req.apiKeyId) recordTokensForRateLimit(req.apiKeyId, (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) +
      (usage.cacheCreationInputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0));
  }
}

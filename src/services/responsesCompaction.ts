import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { CLAUDE_INFERENCE_BACKEND, UPSTREAM_TIMEOUT_MS } from "../config.js";
import { compactCliHistory, CliCompactionError } from "./cliSessions.js";
import { CliBackendError } from "./cliProtocol.js";
import { responsesContext, compactionCodec } from "./responsesContext.js";
import { prepareResponsesCompactionRequest } from "./responsesRequest.js";
import { ResponsesError } from "./responsesTypes.js";
import { resolveUpstreamCredential, missingCredentialMessage } from "./settingsService.js";
import { insertPendingRequest, completeRequest } from "./historyService.js";
import { registerTask, unregisterTask } from "./taskTracker.js";
import { recordTokensForRateLimit } from "../middleware/rateLimiter.js";
import { logOperationalError } from "./operationalLogger.js";
import type { ObservedUsage } from "./usageObserver.js";

/** Compaction usage accounts the actual summarization calls, including cached input. */
export function compactionUsage(usage?: ObservedUsage) {
  if (!usage?.usageComplete || [usage.inputTokens, usage.outputTokens, usage.cacheCreationInputTokens, usage.cacheReadInputTokens]
    .some(value => value === null || !Number.isSafeInteger(value) || value < 0)) return null;
  const input = usage.inputTokens! + usage.cacheCreationInputTokens! + usage.cacheReadInputTokens!;
  const total = input + usage.outputTokens!;
  if (!Number.isSafeInteger(total)) return null;
  return { input_tokens: input, output_tokens: usage.outputTokens!, total_tokens: total,
    input_tokens_details: { cached_tokens: usage.cacheReadInputTokens!, cache_write_tokens: usage.cacheCreationInputTokens! } };
}

/** Stateless external compaction: no stored response IDs and no ordinary inference call. */
export async function compactResponses(req: Request, res: Response): Promise<void> {
  const started = Date.now(), id = `resp_compact_${randomUUID().replaceAll("-", "")}`;
  const controller = new AbortController();
  let timedOut = false, cancelled = false;
  let status: "success" | "error" | "cancelled" = "error";
  let usage: ObservedUsage | undefined;
  let logId: number | undefined;
  const cancel = () => { cancelled = true; controller.abort(); };
  const close = () => { if (!res.writableFinished) cancel(); };
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, UPSTREAM_TIMEOUT_MS);
  timer.unref();
  req.once("aborted", cancel); res.once("close", close);
  try {
    const credential = await resolveUpstreamCredential(() => res.destroyed || controller.signal.aborted);
    if (!credential || /[^\x21-\x7e]/.test(credential.token)) throw new ResponsesError("upstream_not_configured", missingCredentialMessage(), 503);
    const request = responsesContext(req, credential);
    const prepared = prepareResponsesCompactionRequest(request.input, request.options);
    if (CLAUDE_INFERENCE_BACKEND !== "cli") throw new ResponsesError("compaction_backend_unavailable", "Responses compaction requires the CLI inference backend.", 501);
    if (controller.signal.aborted) throw new CliBackendError("request_cancelled", "Request cancelled.", 499);
    logId = insertPendingRequest({ apiKeyId: req.apiKeyId ?? null, completionId: id,
      requestedModel: prepared.model, resolvedModel: prepared.model, isStream: false });
    registerTask({ id, model: prepared.model, promptPreview: "", apiKeyId: req.apiKeyId ?? null, apiKeyName: req.apiKeyName ?? null,
      startedAt: new Date(started).toISOString(), isStreaming: false, requestLogId: logId }, async () => { cancel(); });
    const result = await compactCliHistory(prepared.nativeBody, request.options.context.principal, credential, controller.signal);
    usage = result.usage;
    if (!result.compacted) throw new CliBackendError("compaction_incomplete", "The CLI did not produce a compacted context.", 502);
    const itemId = `cmp_${randomUUID().replaceAll("-", "")}`;
    const output = [...prepared.instructionItems, { type: "compaction", id: itemId,
      encrypted_content: compactionCodec!.seal({ messages: result.messages, historyTools: prepared.historyTools }, prepared.stateContext, itemId) }];
    if (controller.signal.aborted) throw new CliBackendError("request_cancelled", "Request cancelled.", 499);
    status = "success";
    res.setHeader("x-claude-proxy-backend", "cli");
    res.setHeader("x-claude-proxy-compaction", "claude-native");
    res.status(200).json({ id, object: "response.compaction", created_at: Math.floor(Date.now() / 1000), output, usage: compactionUsage(usage) });
  } catch (error) {
    if (error instanceof CliCompactionError) usage = error.usage;
    status = cancelled ? "cancelled" : "error";
    if (!res.destroyed) {
      if (error instanceof CliCompactionError && error.failure && !timedOut && !cancelled) {
        res.status(error.failure.status).type(error.failure.contentType).send(error.failure.body);
        return;
      }
      const problem = error instanceof CliBackendError || error instanceof ResponsesError ? error :
        new CliBackendError("compaction_failed", "The CLI compaction request failed.", 502);
      res.status(timedOut ? 504 : cancelled ? 499 : problem.status).json({ error: {
        type: timedOut || problem.status >= 500 ? "api_error" : "invalid_request_error",
        code: timedOut ? "cli_timeout" : problem.code,
        message: timedOut ? "The CLI compaction request timed out." : problem.message,
      } });
    }
  } finally {
    clearTimeout(timer); req.off("aborted", cancel); res.off("close", close); unregisterTask(id);
    if (logId !== undefined) {
      try {
        completeRequest(logId, status, { ...usage, usageComplete: status === "success" && usage?.usageComplete === true,
          durationMs: Date.now() - started, errorMessage: status === "error" ? "compaction_error" : undefined,
          diagnostics: { upstream_diagnostic: timedOut ? "timeout" : cancelled ? "cancelled" : status === "success" ? "success" : "provider_error" } });
      } catch (error) { logOperationalError("request_history_write_failed", error); }
      if (req.apiKeyId && usage) recordTokensForRateLimit(req.apiKeyId,
        (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0));
    }
  }
}

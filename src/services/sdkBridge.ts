import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import { registerTask, unregisterTask } from "./taskTracker.js";
import { insertPendingRequest, completeRequest } from "./historyService.js";
import { recordTokensForRateLimit } from "../middleware/rateLimiter.js";
import { invalidateBudgetCache } from "../middleware/budgetCheck.js";
import { getOAuthToken } from "./settingsService.js";
import { attachUpstreamText, classifyUpstreamError } from "./errorClassifier.js";
import { ALLOW_SERVER_SIDE_TOOLS } from "../config.js";

const STDERR_TAIL_CHARS = 4000;

interface TrackedQueryParams {
  completionId: string;
  prompt: string;
  requestedModel: string;
  resolvedModel: string;
  isStreaming: boolean;
  apiKeyId: number | null;
  apiKeyName: string | null;
  includePartialMessages?: boolean;
  // Optional, for tool-use support on /v1/messages:
  mcpServers?: Record<string, unknown>;
  allowedTools?: string[];
  disallowedTools?: string[];
  builtInTools?: string[] | { type: "preset"; preset: "claude_code" };
  systemPrompt?: string;
  maxTurns?: number;
  permissionMode?: string;
  cwd?: string;
}

interface TrackedQueryResult {
  generator: AsyncGenerator<any, void>;
  queryHandle: Query;
}

export function trackedQuery(params: TrackedQueryParams): TrackedQueryResult {
  const startTime = Date.now();

  const requestedBuiltins = params.builtInTools;
  if (!ALLOW_SERVER_SIDE_TOOLS && requestedBuiltins &&
      (!Array.isArray(requestedBuiltins) || requestedBuiltins.length > 0)) {
    throw new Error("Server-side tools are disabled in gateway adapter mode");
  }

  // Metadata only. Conversation content belongs to the LiteLLM log store.
  const logId = insertPendingRequest({
    apiKeyId: params.apiKeyId,
    completionId: params.completionId,
    requestedModel: params.requestedModel,
    resolvedModel: params.resolvedModel,
    isStream: params.isStreaming,
  });

  // Assemble SDK options. maxTurns defaults to 1 (existing contract); callers
  // may override. settingSources: [] is set unconditionally so Claude Code
  // doesn't load CLAUDE.md or user settings that could leak instructions.
  const sdkOptions: Record<string, unknown> = {
    model: params.resolvedModel,
    maxTurns: params.maxTurns ?? 1,
    settingSources: [],
    persistSession: false,
    tools: params.builtInTools ?? [],
  };
  // Capture the CLI's stderr so failures are logged with the real cause instead of
  // just "process exited with code 1". Only the tail is kept to bound memory.
  let stderrTail = "";
  sdkOptions.stderr = (data: string) => {
    stderrTail = (stderrTail + data).slice(-STDERR_TAIL_CHARS);
  };
  if (params.includePartialMessages) sdkOptions.includePartialMessages = true;
  if (params.mcpServers) sdkOptions.mcpServers = params.mcpServers;
  if (params.allowedTools) sdkOptions.allowedTools = params.allowedTools;
  if (params.disallowedTools) sdkOptions.disallowedTools = params.disallowedTools;
  if (params.permissionMode) sdkOptions.permissionMode = params.permissionMode;
  if (params.cwd) sdkOptions.cwd = params.cwd;
  if (params.builtInTools !== undefined) sdkOptions.tools = params.builtInTools;
  if (params.systemPrompt !== undefined) sdkOptions.systemPrompt = params.systemPrompt;

  // Inject the OAuth token from database/env into the SDK subprocess environment.
  // This allows the token to be managed via the admin UI instead of env vars.
  const oauthToken = getOAuthToken();
  if (oauthToken) {
    const env: Record<string, string> = {};
    // Only pass the auth-related env vars to the subprocess, plus PATH
    if (process.env.PATH) env.PATH = process.env.PATH;
    if (process.env.HOME) env.HOME = process.env.HOME;
    if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
    if (process.env.TEMP) env.TEMP = process.env.TEMP;
    if (process.env.TMP) env.TMP = process.env.TMP;
    // Set the token — auto-detect which env var to use based on prefix
    if (oauthToken.startsWith("sk-ant-oat")) {
      env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
    } else {
      env.ANTHROPIC_API_KEY = oauthToken;
    }
    sdkOptions.env = env;
  }

  const sdkQuery = query({
    prompt: params.prompt,
    options: sdkOptions,
  });

  // Register active task
  registerTask(
    {
      id: params.completionId,
      model: params.resolvedModel,
      promptPreview: "",
      apiKeyId: params.apiKeyId,
      apiKeyName: params.apiKeyName,
      startedAt: new Date().toISOString(),
      isStreaming: params.isStreaming,
      requestLogId: logId,
    },
    () => sdkQuery.interrupt()
  );

  // Retain bounded, ephemeral text only for upstream error classification.
  async function* wrappedGenerator() {
    let inputTokens = 0;
    let outputTokens = 0;
    let totalCostUsd = 0;
    let responseTail = "";

    try {
      for await (const message of sdkQuery) {
        // Never retain tool arguments for diagnostics.
        if (message.type === "assistant") {
          const content = message.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if ((block as { type: string }).type === "text") {
                responseTail = (responseTail + (block as { text: string }).text).slice(-STDERR_TAIL_CHARS);
              }
            }
          }
        }
        // Capture usage from result messages
        if (message.type === "result") {
          inputTokens = message.usage?.input_tokens ?? 0;
          outputTokens = message.usage?.output_tokens ?? 0;
          totalCostUsd = message.total_cost_usd ?? 0;
        }
        yield message;
      }

      completeRequest(logId, "success", {
        inputTokens,
        outputTokens,
        totalCostUsd,
        durationMs: Date.now() - startTime,
      });

      // Record token usage for rate limiting and invalidate budget cache
      if (params.apiKeyId) {
        recordTokensForRateLimit(params.apiKeyId, inputTokens + outputTokens);
        invalidateBudgetCache(params.apiKeyId);
      }
    } catch (err: any) {
      // Hand the CLI's own words to the route layer so it can pick a status code.
      attachUpstreamText(err, [responseTail, stderrTail].join("\n"));
      completeRequest(logId, "error", {
        inputTokens,
        outputTokens,
        totalCostUsd,
        durationMs: Date.now() - startTime,
        errorMessage: classifyUpstreamError(err).type,
      });
      throw err;
    } finally {
      unregisterTask(params.completionId);
    }
  }

  return { generator: wrappedGenerator(), queryHandle: sdkQuery };
}

export function markCancelled(completionId: string, logId: number, startTime: number): void {
  completeRequest(logId, "cancelled", {
    durationMs: Date.now() - startTime,
  });
  unregisterTask(completionId);
}

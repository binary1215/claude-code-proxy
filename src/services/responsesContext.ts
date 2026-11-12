import type { Request } from "express";
import { ANTHROPIC_BASE_URL, CLAUDE_INFERENCE_BACKEND, RESPONSES_ENABLED, RESPONSES_STATE_KEY,
  RESPONSES_STATE_TTL_SECONDS, RESPONSES_MAX_OUTPUT_TOKENS, RESPONSES_THINKING_BUDGET_TOKENS,
  RESPONSES_APPLY_PATCH_MODE, RESPONSES_DEVELOPER_MESSAGE_MODE } from "../config.js";
import { upstreamUrl } from "./nativeRelay.js";
import { ResponsesStateCodec, upstreamStateScope } from "./responsesState.js";
import { ResponsesCompactionStateCodec } from "./responsesCompactionState.js";
import { ResponsesError, type RequestTranslationOptions } from "./responsesTypes.js";

export const responsesCodec = RESPONSES_ENABLED ? new ResponsesStateCodec(RESPONSES_STATE_KEY, RESPONSES_STATE_TTL_SECONDS) : null;
export const compactionCodec = RESPONSES_ENABLED ? new ResponsesCompactionStateCodec(RESPONSES_STATE_KEY, RESPONSES_STATE_TTL_SECONDS) : null;

/** Both endpoints must use identical authorization, native policy and state bindings. */
export function responsesContext(req: Request, credential: { token: string; kind: "oauth" | "api_key"; stateIdentity?: string }) {
  if (!responsesCodec || !compactionCodec) throw new ResponsesError("upstream_not_configured", "Responses state key is not configured.", 503);
  if (req.originalUrl.includes("?")) throw new ResponsesError("unsupported_parameter", "Query parameters are not supported on the Responses adapter.");
  const model = req.body?.model;
  if (typeof model !== "string" || !model.trim() || model.length > 256) throw new ResponsesError("invalid_model", "A native model ID is required.");
  if (req.allowedModels?.length && !req.allowedModels.includes(model)) throw new ResponsesError("model_not_allowed", "Model is not permitted for this key.", 403);
  const url = upstreamUrl(ANTHROPIC_BASE_URL, "/messages");
  const context = { model, principal: `proxy-key:${req.apiKeyFingerprint ?? "anonymous-development"}`,
    upstream: upstreamStateScope(url.href + (CLAUDE_INFERENCE_BACKEND === "cli" ? "|cli" : ""), credential) };
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
  const options: RequestTranslationOptions = { codec: responsesCodec, compactionCodec, context,
    defaultMaxTokens: RESPONSES_MAX_OUTPUT_TOKENS, defaultThinkingBudget: RESPONSES_THINKING_BUDGET_TOKENS,
    applyPatchMode: RESPONSES_APPLY_PATCH_MODE, developerMessageMode: RESPONSES_DEVELOPER_MESSAGE_MODE };
  return { input, options, url };
}

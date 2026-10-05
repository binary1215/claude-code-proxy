import { createHash } from "node:crypto";
import { MAX_TOOL_CALL_ID_LENGTH, ResponsesError, type JsonObject, type PreparedResponsesRequest, type RequestTranslationOptions, type ToolBinding } from "./responsesTypes.js";

const MAX_OUTPUT_TOKENS = 65_536;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const NAME = /^[A-Za-z0-9_-]+$/;
const own = (value: JsonObject, key: string): boolean => Object.hasOwn(value, key);

function fail(code = "invalid_request", message = "The Responses request is outside the supported adapter contract.", status = 400): never {
  throw new ResponsesError(code, message, status);
}

function object(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail();
  return value as JsonObject;
}

function keys(value: JsonObject, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail("unsupported_parameter");
}

function string(value: unknown, nonempty = false, maximum = Number.MAX_SAFE_INTEGER): string {
  if (typeof value !== "string" || (nonempty && !value.length) || value.length > maximum) fail();
  return value;
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) fail();
  return value;
}

function json(value: unknown, depth = 0): unknown {
  if (depth > 64) fail();
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => json(item, depth + 1));
  const source = object(value);
  // Object.fromEntries avoids setter/prototype behavior for JSON keys such as __proto__.
  return Object.fromEntries(Object.entries(source).map(([key, item]) => [key, json(item, depth + 1)]));
}

function cache(value: unknown): JsonObject {
  const result = object(value);
  keys(result, ["type", "ttl"]);
  if (result.type !== "ephemeral" || (own(result, "ttl") && !["5m", "1h"].includes(result.ttl))) fail();
  return json(result) as JsonObject;
}

function withCache(block: JsonObject, source: JsonObject): JsonObject {
  if (own(source, "cache_control")) block.cache_control = cache(source.cache_control);
  return block;
}

function name(value: unknown, maximum = 64): string {
  const result = string(value, true, maximum);
  if (!NAME.test(result)) fail("unsupported_tool");
  return result;
}

function identity(kind: string, toolName: string, namespace?: string): string {
  return JSON.stringify([kind, namespace ?? null, toolName]);
}

function nativeName(toolName: string, namespace?: string): string {
  return namespace === undefined ? toolName : "ns_" + createHash("sha256").update(JSON.stringify([namespace, toolName])).digest("hex").slice(0, 60);
}

function image(source: JsonObject): JsonObject {
  keys(source, ["type", "image_url", "detail", "cache_control"]);
  if (own(source, "detail") && source.detail !== "auto" && source.detail !== null) fail("unsupported_parameter", "Image detail conversion is not supported.");
  const value = string(source.image_url, true, 8 * 1024 * 1024);
  const data = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  let nativeSource: JsonObject;
  if (data) {
    const decoded = Buffer.from(data[2], "base64");
    if (!decoded.length || decoded.length > MAX_IMAGE_BYTES || decoded.toString("base64").replace(/=+$/, "") !== data[2].replace(/=+$/, "")) fail();
    nativeSource = { type: "base64", media_type: data[1], data: data[2] };
  } else {
    if (value.length > 8192) fail();
    let url: URL;
    try { url = new URL(value); } catch { fail(); }
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) fail();
    nativeSource = { type: "url", url: value };
  }
  // No fetch, file lookup, image decoding/dimension validation, or native detail emulation.
  return withCache({ type: "image", source: nativeSource }, source);
}

function content(value: unknown, images: boolean): JsonObject[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (!Array.isArray(value) || !value.length) fail();
  return value.map(entry => {
    const block = object(entry);
    if (["input_text", "output_text", "text"].includes(block.type)) {
      keys(block, ["type", "text", "cache_control", "annotations", "logprobs"]);
      if (own(block, "annotations") && (!Array.isArray(block.annotations) || block.annotations.length)) fail("unsupported_parameter");
      if (own(block, "logprobs") && block.logprobs !== null && (!Array.isArray(block.logprobs) || block.logprobs.length)) fail("unsupported_parameter");
      return withCache({ type: "text", text: string(block.text) }, block);
    }
    if (block.type === "input_image" && images) return image(block);
    fail("unsupported_parameter", "This input content type is not supported.");
  });
}

function thinkingPolicy(request: JsonObject, extension: JsonObject, options: RequestTranslationOptions, maxTokens: number): JsonObject | undefined {
  const reasoning = own(request, "reasoning") ? object(request.reasoning) : {};
  keys(reasoning, ["effort", "summary"]);
  if (own(reasoning, "summary") && !["auto", "concise", "detailed"].includes(reasoning.summary)) fail("unsupported_parameter");
  const effort = reasoning.effort;
  let output: JsonObject | undefined;
  if (own(extension, "output_config")) {
    output = object(extension.output_config);
    keys(output, ["effort"]);
    if (!own(output, "effort") || !["low", "medium", "high", "max"].includes(output.effort)) fail("unsupported_parameter");
  }
  let thinking: JsonObject;
  if (own(extension, "thinking")) {
    thinking = object(extension.thinking);
    if (thinking.type === "enabled") {
      keys(thinking, ["type", "budget_tokens"]);
      integer(thinking.budget_tokens, 1024, maxTokens - 1);
    } else if (["disabled", "adaptive"].includes(thinking.type)) {
      keys(thinking, ["type"]);
    } else fail("unsupported_parameter");
  } else {
    const budget = integer(effort === "none" ? 0 : options.defaultThinkingBudget, 0, MAX_OUTPUT_TOKENS - 1);
    if (budget > 0) integer(budget, 1024, maxTokens - 1);
    thinking = budget ? { type: "enabled", budget_tokens: budget } : { type: "disabled" };
  }
  if (effort === "none") {
    if ((own(extension, "thinking") && thinking.type !== "disabled") || output) fail("unsupported_parameter");
    return undefined;
  }
  if (effort !== undefined) {
    // No guessed mapping of OpenAI effort to an Anthropic token budget.
    if (!["low", "medium", "high"].includes(effort) || thinking.type !== "adaptive" || output?.effort !== effort) fail("unsupported_parameter", "Reasoning effort requires an explicit matching native adaptive policy.");
  }
  if (output && thinking.type !== "adaptive") fail("unsupported_parameter");
  return thinking.type === "disabled" ? undefined : json(thinking) as JsonObject;
}

/** Strict stateless translation. Signed state is opened only through the bound codec.
 * Images: inline PNG/JPEG/GIF/WebP <=5 MiB decoded, or HTTPS URL <=8192 chars;
 * detail auto only, no local files/file IDs/fetches. Historical calls require current
 * tool definitions. Client IDs/cache keys/summary hints are never prompt text.
 */
export function prepareResponsesRequest(input: unknown, options: RequestTranslationOptions): PreparedResponsesRequest {
  const request = object(input);
  keys(request, ["model", "input", "instructions", "tools", "tool_choice", "parallel_tool_calls", "max_output_tokens", "temperature", "top_p", "stream", "store", "previous_response_id", "background", "truncation", "reasoning", "text", "include", "client_metadata", "prompt_cache_key", "anthropic"]);
  const model = string(request.model, true, 256);
  if (model !== options.context.model) fail("invalid_reasoning_state", "The state context model does not match the requested native model.", 409);
  if ((own(request, "store") && request.store !== false) || (own(request, "previous_response_id") && request.previous_response_id !== null) || (own(request, "background") && request.background !== false) || (own(request, "truncation") && request.truncation !== "disabled")) fail("unsupported_parameter", "Only stateless foreground requests with disabled truncation are supported.");
  if (own(request, "stream") && typeof request.stream !== "boolean") fail();
  if (own(request, "include") && (!Array.isArray(request.include) || request.include.some((item: unknown) => item !== "reasoning.encrypted_content"))) fail("unsupported_parameter");
  if (own(request, "client_metadata")) json(object(request.client_metadata));
  if (own(request, "prompt_cache_key")) string(request.prompt_cache_key);
  if (own(request, "text")) {
    const text = object(request.text);
    keys(text, ["format"]);
    if (own(text, "format")) {
      const format = object(text.format);
      keys(format, ["type"]);
      if (format.type !== "text") fail("unsupported_parameter");
    }
  }
  const extension = own(request, "anthropic") ? object(request.anthropic) : {};
  keys(extension, ["thinking", "output_config", "cache_control"]);
  const maxTokens = integer(own(request, "max_output_tokens") ? request.max_output_tokens : options.defaultMaxTokens, 1, MAX_OUTPUT_TOKENS);
  const thinking = thinkingPolicy(request, extension, options, maxTokens);
  const nativeBody: JsonObject = { model, max_tokens: maxTokens, messages: [], stream: request.stream ?? false };
  if (thinking) nativeBody.thinking = thinking;
  if (own(extension, "output_config")) nativeBody.output_config = json(extension.output_config);
  if (own(extension, "cache_control")) nativeBody.cache_control = cache(extension.cache_control);
  for (const key of ["temperature", "top_p"]) {
    if (own(request, key)) {
      if (typeof request[key] !== "number" || !Number.isFinite(request[key]) || request[key] < 0 || request[key] > 1) fail();
      nativeBody[key] = request[key];
    }
  }
  if (thinking && ((own(request, "temperature") && request.temperature !== 1) || own(request, "top_p"))) fail("unsupported_parameter", "Sampling overrides with native thinking are not supported.");

  const tools = new Map<string, ToolBinding>();
  const identities = new Map<string, ToolBinding>();
  const namespaces = new Set<string>();
  const definitions: JsonObject[] = [];
  const addTool = (value: unknown, namespace?: string, namespaceDescription?: string): void => {
    const tool = object(value);
    if (!["function", "custom"].includes(tool.type)) fail("unsupported_tool", "Only client-executed function and free-text tools are supported.");
    keys(tool, ["type", "name", "description", "parameters", "strict", "format", "cache_control"]);
    const toolName = name(tool.name, namespace === undefined ? 64 : 128);
    if (own(tool, "strict") && tool.strict !== false && tool.strict !== null) fail("unsupported_tool", "Strict tool enforcement is not supported.");
    if (own(tool, "description") && tool.description !== null) string(tool.description);
    let schema: JsonObject;
    if (tool.type === "custom") {
      if (own(tool, "parameters") || own(tool, "strict")) fail("unsupported_tool");
      if (own(tool, "format")) {
        const format = object(tool.format);
        if (format.type !== "text") fail("unsupported_tool", "Grammar tools are not supported.");
        keys(format, ["type"]);
      }
      schema = { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false };
    } else {
      if (own(tool, "format")) fail("unsupported_tool");
      schema = own(tool, "parameters") && tool.parameters !== null ? object(tool.parameters) : { type: "object", properties: {} };
      if (schema.type !== "object") fail("unsupported_tool");
      schema = json(schema) as JsonObject;
    }
    const flattened = nativeName(toolName, namespace);
    if (tools.has(flattened)) fail("unsupported_tool", "Tool names collide after namespace translation.");
    const binding: ToolBinding = { nativeName: flattened, name: toolName, kind: tool.type, ...(namespace === undefined ? {} : { namespace }) };
    tools.set(flattened, binding);
    identities.set(identity(binding.kind, toolName, namespace), binding);
    const description = [namespaceDescription, tool.description].filter(part => typeof part === "string" && part.length).join("\n\n");
    definitions.push(withCache({ name: flattened, input_schema: schema, ...(description ? { description } : {}) }, tool));
  };
  if (own(request, "tools")) {
    if (!Array.isArray(request.tools)) fail();
    for (const value of request.tools) {
      const tool = object(value);
      if (tool.type === "namespace") {
        keys(tool, ["type", "name", "description", "tools"]);
        const namespace = name(tool.name, 128);
        if (namespaces.has(namespace)) fail("unsupported_tool", "Duplicate tool namespaces are not supported.");
        namespaces.add(namespace);
        if (!Array.isArray(tool.tools) || !tool.tools.length) fail("unsupported_tool");
        if (own(tool, "description")) string(tool.description);
        for (const child of tool.tools) addTool(child, namespace, tool.description);
      } else addTool(tool);
    }
  }
  if (definitions.length) nativeBody.tools = definitions;
  const resolveTool = (kind: string, toolName: unknown, namespace: unknown): ToolBinding => {
    const sourceName = name(toolName, namespace === undefined ? 64 : 128);
    const sourceNamespace = namespace === undefined ? undefined : name(namespace, 128);
    const result = identities.get(identity(kind, sourceName, sourceNamespace));
    if (!result) fail("invalid_tool_history", "A tool reference has no matching current definition.");
    return result;
  };
  if (own(request, "tool_choice") || own(request, "parallel_tool_calls")) {
    if (own(request, "parallel_tool_calls") && typeof request.parallel_tool_calls !== "boolean") fail();
    const choice = request.tool_choice ?? "auto";
    let translated: JsonObject;
    if (typeof choice === "string" && ["auto", "required", "none"].includes(choice)) translated = { type: choice === "required" ? "any" : choice };
    else {
      const selected = object(choice);
      keys(selected, ["type", "name", "namespace"]);
      if (!["function", "custom"].includes(selected.type)) fail("unsupported_tool");
      translated = { type: "tool", name: resolveTool(selected.type, selected.name, selected.namespace).nativeName };
    }
    if (!definitions.length && !["auto", "none"].includes(translated.type)) fail("unsupported_tool");
    if (thinking && !["auto", "none"].includes(translated.type)) fail("unsupported_parameter", "Forced tool choices with native thinking are not supported.");
    if (own(request, "parallel_tool_calls") && translated.type !== "none") translated.disable_parallel_tool_use = !request.parallel_tool_calls;
    if (definitions.length) nativeBody.tool_choice = translated;
  }

  const system: JsonObject[] = [];
  if (own(request, "instructions") && request.instructions !== null) system.push({ type: "text", text: string(request.instructions) });
  let begun = false;
  const pending = new Map<string, "function" | "custom">();
  const calls = new Set<string>();
  const reasoningIds = new Set<string>();
  const append = (role: "user" | "assistant", blocks: JsonObject[]): void => {
    begun = true;
    const messages = nativeBody.messages as JsonObject[];
    const previous = messages.at(-1);
    if (previous?.role === role) previous.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  const items = typeof request.input === "string" ? [{ type: "message", role: "user", content: request.input }] : request.input;
  if (!Array.isArray(items) || !items.length) fail();
  for (const value of items) {
    const item = object(value);
    const type = item.type ?? (own(item, "role") ? "message" : undefined);
    if (type === "message") {
      keys(item, ["type", "role", "content", "id", "status"]);
      if (own(item, "id")) string(item.id, true);
      if (own(item, "status") && item.status !== "completed") fail();
      if (["system", "developer"].includes(item.role)) {
        if (begun) fail("unsupported_parameter", "System and developer messages are allowed only in the initial prefix.");
        system.push(...content(item.content, false));
      } else if (["user", "assistant"].includes(item.role)) {
        if (pending.size && (item.role === "user" || nativeBody.messages.at(-1)?.role !== "assistant")) fail("invalid_tool_history", "Every pending tool call must be answered before another message turn.");
        append(item.role, content(item.content, item.role === "user"));
      } else fail();
    } else if (type === "reasoning") {
      keys(item, ["type", "id", "encrypted_content", "summary", "status", "content"]);
      if (typeof item.id !== "string" || !item.id.length || typeof item.encrypted_content !== "string" || !item.encrypted_content.length) fail("invalid_reasoning_state", "Reasoning replay requires an item ID and encrypted state.");
      const id = string(item.id, true);
      const sealed = string(item.encrypted_content, true);
      if (reasoningIds.has(id)) fail("invalid_reasoning_state", "A reasoning item is duplicated.");
      if (own(item, "content") && item.content !== null && (!Array.isArray(item.content) || item.content.length)) fail("unsupported_parameter", "Public reasoning content is not an authoritative replay state.");
      if (own(item, "status") && item.status !== "completed") fail("invalid_reasoning_state");
      if (own(item, "summary")) {
        if (!Array.isArray(item.summary)) fail();
        for (const entry of item.summary) {
          const summary = object(entry);
          keys(summary, ["type", "text"]);
          if (summary.type !== "summary_text") fail();
          string(summary.text);
        }
      }
      let opened: JsonObject;
      try { opened = object(options.codec.open(sealed, options.context, id)); }
      catch { fail("invalid_reasoning_state", "The encrypted reasoning state is invalid or bound to another request context.", 409); }
      if (opened.type === "thinking") {
        if (typeof opened.thinking !== "string" || typeof opened.signature !== "string" || !opened.signature.length) fail("invalid_reasoning_state");
      } else if (opened.type === "redacted_thinking") {
        if (typeof opened.data !== "string" || !opened.data.length) fail("invalid_reasoning_state");
      } else fail("invalid_reasoning_state");
      if (pending.size && nativeBody.messages.at(-1)?.role !== "assistant") fail("invalid_tool_history");
      reasoningIds.add(id);
      append("assistant", [json(opened) as JsonObject]);
    } else if (["function_call", "custom_tool_call"].includes(type)) {
      keys(item, ["type", "id", "call_id", "name", "namespace", "arguments", "input", "status", "cache_control"]);
      if (own(item, "id")) string(item.id, true);
      if (own(item, "status") && item.status !== "completed") fail("invalid_tool_history");
      const kind = type === "function_call" ? "function" : "custom";
      const binding = resolveTool(kind, item.name, item.namespace);
      const callId = string(item.call_id, true, MAX_TOOL_CALL_ID_LENGTH);
      if (calls.has(callId) || (pending.size && nativeBody.messages.at(-1)?.role !== "assistant")) fail("invalid_tool_history", "Tool call identifiers or ordering are invalid.");
      let args: JsonObject;
      if (kind === "function") {
        if (own(item, "input")) fail("invalid_tool_history");
        try { args = object(JSON.parse(string(item.arguments))); } catch { fail("invalid_tool_history", "Function arguments must encode a JSON object."); }
      } else {
        if (own(item, "arguments")) fail("invalid_tool_history");
        args = { input: string(item.input) };
      }
      calls.add(callId);
      pending.set(callId, kind);
      append("assistant", [withCache({ type: "tool_use", id: callId, name: binding.nativeName, input: json(args) }, item)]);
    } else if (["function_call_output", "custom_tool_call_output"].includes(type)) {
      keys(item, ["type", "id", "call_id", "output", "is_error", "cache_control"]);
      if (own(item, "id")) string(item.id, true);
      const callId = string(item.call_id, true, MAX_TOOL_CALL_ID_LENGTH);
      if (pending.get(callId) !== (type === "function_call_output" ? "function" : "custom")) fail("invalid_tool_history", "Tool output must match an earlier unanswered tool call of the same type.");
      if (own(item, "is_error") && typeof item.is_error !== "boolean") fail();
      const result: JsonObject = { type: "tool_result", tool_use_id: callId, content: typeof item.output === "string" ? item.output : content(item.output, true) };
      if (own(item, "is_error")) result.is_error = item.is_error;
      append("user", [withCache(result, item)]);
      pending.delete(callId);
    } else fail("unsupported_parameter", "This Responses input item type is not supported.");
  }
  if (pending.size) fail("invalid_tool_history", "Unanswered tool calls cannot be sent for another model turn.");
  if (!nativeBody.messages.length) fail();
  if (system.length) nativeBody.system = system;
  return { nativeBody, tools, stream: request.stream ?? false, model };
}

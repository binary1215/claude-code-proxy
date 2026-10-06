import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { validPatchInput } from "./responsesPatchGrammar.js";
import { MESSAGE_METADATA_KEYS, nativeMetadata } from "./responsesMetadata.js";
import { JsonObject, ResponseTranslationOptions, ResponsesError, ToolBinding, MAX_TOOL_CALL_ID_LENGTH } from "./responsesTypes.js";

const TOTAL_LIMIT = 8 * 1024 * 1024;
const EVENT_LIMIT = 1024 * 1024;
const BLOCK_LIMIT = 1024 * 1024;
const BLOCK_COUNT_LIMIT = 512;
const SAFE_ERRORS: Record<string, string> = {
  invalid_upstream_event: "The upstream stream contained an invalid event.",
  unsupported_upstream_event: "The upstream event is not supported by this adapter.",
  unsupported_upstream_block: "The upstream content block is not supported by this adapter.",
  unsupported_upstream_delta: "The upstream delta is not supported by this adapter.",
  malformed_tool_input: "The upstream tool input was not a supported JSON object.",
  invalid_tool_grammar: "The upstream tool input did not match its declared grammar.",
  unknown_upstream_tool: "The upstream tool was not declared in this request.",
  invalid_upstream_usage: "The upstream usage counters were invalid.",
  invalid_upstream_metadata: "The upstream response metadata was invalid or unsupported.",
  provider_refusal: "The upstream model declined this response.",
  incomplete_upstream_stream: "The upstream stream ended before a complete message.",
  upstream_limit_exceeded: "The upstream stream exceeded the adapter's bounded limits.",
  reasoning_state_error: "The upstream reasoning state could not be preserved.",
  upstream_timeout: "The upstream request timed out.",
  cancelled: "The request was cancelled.",
  upstream_error: "The upstream request failed.",
};

function problem(code: string): never {
  throw new ResponsesError(code, SAFE_ERRORS[code] ?? SAFE_ERRORS.upstream_error, 502);
}
function record(value: any): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }
function size(value: any): number { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
function keys(value: JsonObject, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) problem("unsupported_upstream_event");
}
function token(value: any): value is number { return Number.isSafeInteger(value) && value >= 0; }
function id(prefix: string): string { return `${prefix}_${randomUUID().replaceAll("-", "")}`; }

/** Bounded SSE framing only. The translation state machine validates native semantics. */
export class NativeSseDecoder {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private line = "";
  private data: string[] = [];
  private eventName: string | undefined;
  private afterCR = false;
  private totalBytes = 0;
  private eventBytes = 0;
  private ended = false;
  private broken = false;

  write(bytes: Buffer): JsonObject[] {
    if (this.ended || this.broken) problem("invalid_upstream_event");
    this.totalBytes += bytes.length;
    if (this.totalBytes > TOTAL_LIMIT) { this.broken = true; problem("upstream_limit_exceeded"); }
    try { return this.consume(this.decoder.decode(bytes, { stream: true })); }
    catch (error) {
      this.broken = true;
      if (error instanceof ResponsesError) throw error;
      problem("invalid_upstream_event");
    }
  }

  end(): JsonObject[] {
    if (this.ended || this.broken) problem("invalid_upstream_event");
    this.ended = true;
    try {
      const result = this.consume(this.decoder.decode());
      if (this.line.length || this.data.length || this.eventName !== undefined) problem("incomplete_upstream_stream");
      return result;
    } catch (error) {
      this.broken = true;
      if (error instanceof ResponsesError) throw error;
      problem("invalid_upstream_event");
    }
  }

  private consume(text: string): JsonObject[] {
    const result: JsonObject[] = [];
    for (const char of text) {
      if (this.afterCR && char === "\n") { this.afterCR = false; continue; }
      this.afterCR = false;
      this.eventBytes += Buffer.byteLength(char, "utf8");
      if (this.eventBytes > EVENT_LIMIT) problem("upstream_limit_exceeded");
      if (char === "\r" || char === "\n") {
        this.readLine(result);
        this.afterCR = char === "\r";
      } else this.line += char;
    }
    return result;
  }

  private readLine(result: JsonObject[]): void {
    const line = this.line;
    this.line = "";
    if (line === "") {
      if (this.data.length) {
        let value: any;
        try { value = JSON.parse(this.data.join("\n")); } catch { problem("invalid_upstream_event"); }
        if (!record(value) || typeof value.type !== "string"
          || (this.eventName !== undefined && this.eventName !== value.type)) problem("invalid_upstream_event");
        result.push(value);
      }
      this.data = [];
      this.eventName = undefined;
      this.eventBytes = 0;
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const name = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (name === "data") this.data.push(value);
    else if (name === "event") this.eventName = value;
    // SSE id/retry and unknown framing fields have no native content semantics.
  }
}

interface BlockState {
  native: JsonObject;
  item: JsonObject;
  index: number;
  bytes: number;
  tool?: ToolBinding;
  partialJSON: string;
  inputDeltaSeen: boolean;
  summaryStarted: boolean;
  signatureStarted: boolean;
}

/** One native block maps to one ordered output item. No tool execution or content logging. */
export class ResponsesStream {
  private readonly options: ResponseTranslationOptions;
  private readonly value: JsonObject;
  private sequence = 0;
  private totalBytes = 0;
  private started = false;
  private stopped = false;
  private failed = false;
  private illegalTrailingEvent = false;
  private active: BlockState | undefined;
  private nextBlock = 0;
  private messageDeltaSeen = false;
  private stopReason: string | null = null;
  private nativeUsage: JsonObject | null = null;
  private callIDs = new Set<string>();
  private refused = false;

  constructor(options: ResponseTranslationOptions) {
    this.options = { ...options, tools: new Map(options.tools) };
    this.value = {
      id: id("resp"), object: "response", created_at: Math.floor(Date.now() / 1000),
      status: "in_progress", model: options.model, output: [], error: null,
      incomplete_details: null, usage: null, anthropic_usage: null,
    };
  }

  get response(): JsonObject { return clone(this.value); }
  get terminal(): boolean { return this.stopped || this.failed; }

  push(event: JsonObject): JsonObject[] {
    if (this.terminal) {
      if (this.stopped && record(event) && event.type === "ping" && Object.keys(event).length === 1) return [];
      this.illegalTrailingEvent = true;
      problem("invalid_upstream_event");
    }
    try {
      if (!record(event) || typeof event.type !== "string") problem("invalid_upstream_event");
      const bytes = size(event);
      this.totalBytes += bytes;
      if (bytes > EVENT_LIMIT || this.totalBytes > TOTAL_LIMIT) problem("upstream_limit_exceeded");
      return this.handle(event);
    } catch (error) {
      return this.fail(error instanceof ResponsesError ? error.code : "invalid_upstream_event", "");
    }
  }

  finish(): void {
    if (this.illegalTrailingEvent) problem("invalid_upstream_event");
    if (!this.stopped || this.failed) problem("incomplete_upstream_stream");
  }

  fail(code: string, _message: string): JsonObject[] {
    if (this.terminal) return [];
    this.failed = true;
    const safeCode = Object.hasOwn(SAFE_ERRORS, code) ? code : "upstream_error";
    this.value.status = "failed";
    this.value.error = { code: safeCode, message: SAFE_ERRORS[safeCode] };
    return [this.emit("response.failed", { response: this.value })];
  }

  private emit(type: string, data: JsonObject): JsonObject {
    return clone({ type, sequence_number: this.sequence++, ...data });
  }

  private handle(event: JsonObject): JsonObject[] {
    if (event.type === "ping") { keys(event, ["type"]); return []; }
    if (event.type === "error") return this.fail("upstream_error", "");
    if (event.type === "message_start") {
      keys(event, ["type", "message"]);
      const message = event.message;
      if (this.started || !record(message)) problem("invalid_upstream_event");
      keys(message, ["id", "type", "role", "model", "content", "stop_reason", "stop_sequence", "usage", ...MESSAGE_METADATA_KEYS]);
      if (message.type !== "message" || message.role !== "assistant" || !Array.isArray(message.content)
        || message.content.length || message.stop_reason != null || message.stop_sequence != null
        || message.model !== this.options.model || typeof message.id !== "string"
        || !message.id.length || message.id.length > 256) problem("invalid_upstream_event");
      this.started = true;
      this.updateMetadata(message, true);
      if (message.usage !== undefined) this.updateUsage(message.usage);
      return [this.emit("response.created", { response: this.value }), this.emit("response.in_progress", { response: this.value })];
    }
    if (!this.started) problem("invalid_upstream_event");
    if (event.type === "content_block_start") {
      keys(event, ["type", "index", "content_block"]);
      if (this.active || this.messageDeltaSeen || event.index !== this.nextBlock || !record(event.content_block)) problem("invalid_upstream_event");
      if (this.nextBlock >= BLOCK_COUNT_LIMIT) problem("upstream_limit_exceeded");
      return this.startBlock(event.content_block);
    }
    if (event.type === "content_block_delta") {
      keys(event, ["type", "index", "delta"]);
      if (!this.active || event.index !== this.active.index || !record(event.delta)) problem("invalid_upstream_event");
      return this.delta(event.delta);
    }
    if (event.type === "content_block_stop") {
      keys(event, ["type", "index"]);
      if (!this.active || event.index !== this.active.index) problem("invalid_upstream_event");
      return this.stopBlock();
    }
    if (event.type === "message_delta") {
      keys(event, ["type", "delta", "usage"]);
      if (this.active || !record(event.delta)) problem("invalid_upstream_event");
      keys(event.delta, ["stop_reason", "stop_sequence", "container", "stop_details"]);
      if (event.delta.stop_sequence !== undefined && event.delta.stop_sequence !== null
        && typeof event.delta.stop_sequence !== "string") problem("invalid_upstream_event");
      const reason = event.delta.stop_reason;
      if (reason !== undefined && reason !== null) {
        if (!["end_turn", "tool_use", "stop_sequence", "max_tokens", "refusal"].includes(reason)) problem("unsupported_upstream_event");
        if (this.stopReason !== null && this.stopReason !== reason) problem("invalid_upstream_event");
        this.stopReason = reason;
        if (reason === "refusal") this.refused = true;
      }
      this.updateMetadata(event.delta, false);
      if (event.usage !== undefined) this.updateUsage(event.usage, true);
      this.messageDeltaSeen = true;
      return [];
    }
    if (event.type === "message_stop") {
      keys(event, ["type"]);
      if (this.active || !this.messageDeltaSeen || !this.stopReason) problem("invalid_upstream_event");
      if (this.stopReason === "tool_use" && this.callIDs.size === 0) problem("invalid_upstream_event");
      if (this.refused) return this.fail("provider_refusal", "");
      this.stopped = true;
      const incomplete = this.stopReason === "max_tokens";
      this.value.status = incomplete ? "incomplete" : "completed";
      if (incomplete) this.value.incomplete_details = { reason: "max_output_tokens" };
      return [this.emit(incomplete ? "response.incomplete" : "response.completed", { response: this.value })];
    }
    problem("unsupported_upstream_event");
  }

  private startBlock(block: JsonObject): JsonObject[] {
    const native = clone(block);
    if (size(native) > BLOCK_LIMIT) problem("upstream_limit_exceeded");
    let item: JsonObject;
    let tool: ToolBinding | undefined;
    if (native.type === "thinking") {
      if (typeof native.thinking !== "string" || (native.signature !== undefined && typeof native.signature !== "string")) problem("invalid_upstream_event");
      item = { id: id("rs"), type: "reasoning", summary: [] };
    } else if (native.type === "redacted_thinking") {
      if (typeof native.data !== "string" || !native.data.length) problem("reasoning_state_error");
      item = { id: id("rs"), type: "reasoning", summary: [] };
    } else if (native.type === "text") {
      keys(native, ["type", "text", "citations"]);
      if (typeof native.text !== "string") problem("invalid_upstream_event");
      // An absent/null/empty citation list all mean no annotations. Actual
      // citations still require a translation contract and cannot be discarded.
      if (Object.hasOwn(native, "citations") && native.citations !== null &&
          (!Array.isArray(native.citations) || native.citations.length)) problem("unsupported_upstream_block");
      item = { id: id("msg"), type: "message", role: "assistant", status: "in_progress", content: [] };
    } else if (native.type === "tool_use") {
      keys(native, ["type", "id", "name", "input", "caller", "toolset_name"]);
      // Responses function/custom calls here are direct client-executed calls.
      // Explicit native defaults map to that same contract; server-tool callers
      // and toolsets are not silently converted into ordinary client tools.
      if (Object.hasOwn(native, "caller") && (!record(native.caller) ||
          Object.keys(native.caller).length !== 1 || native.caller.type !== "direct")) problem("unsupported_upstream_block");
      if (Object.hasOwn(native, "toolset_name") && native.toolset_name !== null) problem("unsupported_upstream_block");
      if (typeof native.id !== "string" || !native.id.length || native.id.length > MAX_TOOL_CALL_ID_LENGTH || this.callIDs.has(native.id)
        || typeof native.name !== "string" || !record(native.input)) problem("invalid_upstream_event");
      tool = this.options.tools.get(native.name);
      if (!tool || tool.nativeName !== native.name) problem("unknown_upstream_tool");
      this.callIDs.add(native.id);
      item = { id: id(tool.kind === "custom" ? "ctc" : "fc"),
        type: tool.kind === "custom" ? "custom_tool_call" : "function_call",
        call_id: native.id, name: tool.name, status: "in_progress",
        ...(tool.namespace === undefined ? {} : { namespace: tool.namespace }),
        ...(tool.kind === "custom" ? { input: "" } : { arguments: "" }),
      };
    } else problem("unsupported_upstream_block");
    const state: BlockState = { native, item, index: this.nextBlock, bytes: size(native), tool,
      partialJSON: "", inputDeltaSeen: false, summaryStarted: false, signatureStarted: false };
    this.active = state;
    this.value.output.push(item);
    const result = [this.emit("response.output_item.added", { output_index: state.index, item })];
    if (native.type === "text") {
      const part = { type: "output_text", text: "", annotations: [], logprobs: [] };
      item.content.push(part);
      result.push(this.emit("response.content_part.added", { item_id: item.id, output_index: state.index, content_index: 0, part }));
      if (native.text.length) {
        part.text = native.text;
        result.push(this.emit("response.output_text.delta", { item_id: item.id, output_index: state.index, content_index: 0, delta: native.text, logprobs: [] }));
      }
    } else if (native.type === "thinking" && native.thinking.length) result.push(...this.thinking(native.thinking));
    return result;
  }

  private thinking(text: string): JsonObject[] {
    const state = this.active!;
    const result: JsonObject[] = [];
    if (!state.summaryStarted) {
      state.summaryStarted = true;
      state.item.summary.push({ type: "summary_text", text: "" });
      result.push(this.emit("response.reasoning_summary_part.added", {
        item_id: state.item.id, output_index: state.index, summary_index: 0, part: state.item.summary[0],
      }));
    }
    state.item.summary[0].text += text;
    result.push(this.emit("response.reasoning_summary_text.delta", {
      item_id: state.item.id, output_index: state.index, summary_index: 0, delta: text,
    }));
    return result;
  }

  private delta(delta: JsonObject): JsonObject[] {
    const state = this.active!;
    state.bytes += size(delta);
    if (state.bytes > BLOCK_LIMIT) problem("upstream_limit_exceeded");
    const base = { item_id: state.item.id, output_index: state.index };
    if (state.native.type === "thinking" && delta.type === "thinking_delta") {
      keys(delta, ["type", "thinking"]);
      if (typeof delta.thinking !== "string" || state.signatureStarted) problem("invalid_upstream_event");
      state.native.thinking += delta.thinking;
      return delta.thinking.length ? this.thinking(delta.thinking) : [];
    }
    if (state.native.type === "thinking" && delta.type === "signature_delta") {
      keys(delta, ["type", "signature"]);
      if (typeof delta.signature !== "string") problem("invalid_upstream_event");
      state.signatureStarted = true;
      state.native.signature = (state.native.signature ?? "") + delta.signature;
      return [];
    }
    if (state.native.type === "text" && delta.type === "text_delta") {
      keys(delta, ["type", "text"]);
      if (typeof delta.text !== "string") problem("invalid_upstream_event");
      state.native.text += delta.text;
      state.item.content[0].text += delta.text;
      return [this.emit("response.output_text.delta", { ...base, content_index: 0, delta: delta.text, logprobs: [] })];
    }
    if (state.native.type === "tool_use" && delta.type === "input_json_delta") {
      keys(delta, ["type", "partial_json"]);
      if (typeof delta.partial_json !== "string" || Object.keys(state.native.input).length) problem("malformed_tool_input");
      state.inputDeltaSeen = true;
      state.partialJSON += delta.partial_json;
      if (state.tool!.kind === "custom") return [];
      state.item.arguments += delta.partial_json;
      return [this.emit("response.function_call_arguments.delta", { ...base, delta: delta.partial_json })];
    }
    problem("unsupported_upstream_delta");
  }

  private stopBlock(): JsonObject[] {
    const state = this.active!;
    const base = { item_id: state.item.id, output_index: state.index };
    const result: JsonObject[] = [];
    if (state.native.type === "thinking" || state.native.type === "redacted_thinking") {
      if (state.native.type === "thinking" && (typeof state.native.signature !== "string" || !state.native.signature.length)) problem("reasoning_state_error");
      try { state.item.encrypted_content = this.options.seal(clone(state.native), state.item.id); }
      catch { problem("reasoning_state_error"); }
      if (typeof state.item.encrypted_content !== "string" || !state.item.encrypted_content.length) problem("reasoning_state_error");
      if (state.summaryStarted) {
        result.push(this.emit("response.reasoning_summary_text.done", { ...base, summary_index: 0, text: state.item.summary[0].text }));
        result.push(this.emit("response.reasoning_summary_part.done", { ...base, summary_index: 0, part: state.item.summary[0] }));
      }
    } else if (state.native.type === "text") {
      result.push(this.emit("response.output_text.done", { ...base, content_index: 0, text: state.native.text, logprobs: [] }));
      result.push(this.emit("response.content_part.done", { ...base, content_index: 0, part: state.item.content[0] }));
      state.item.status = "completed";
    } else {
      if (state.inputDeltaSeen) {
        try { state.native.input = JSON.parse(state.partialJSON); } catch { problem("malformed_tool_input"); }
        if (!record(state.native.input)) problem("malformed_tool_input");
      }
      if (state.tool!.kind === "custom") {
        if (Object.keys(state.native.input).length !== 1 || typeof state.native.input.input !== "string") problem("malformed_tool_input");
        if (state.tool!.grammar && !validPatchInput(state.native.input.input, state.tool!.grammar!)) problem("invalid_tool_grammar");
        state.item.input = state.native.input.input;
        if (state.item.input.length) result.push(this.emit("response.custom_tool_call_input.delta", { ...base, delta: state.item.input }));
        result.push(this.emit("response.custom_tool_call_input.done", { ...base, input: state.item.input }));
      } else {
        if (!state.inputDeltaSeen) {
          state.item.arguments = JSON.stringify(state.native.input);
          result.push(this.emit("response.function_call_arguments.delta", { ...base, delta: state.item.arguments }));
        }
        result.push(this.emit("response.function_call_arguments.done", { ...base, arguments: state.item.arguments }));
      }
      state.item.status = "completed";
    }
    result.push(this.emit("response.output_item.done", { output_index: state.index, item: state.item }));
    this.active = undefined;
    this.nextBlock++;
    return result;
  }

  private updateMetadata(source: JsonObject, initial: boolean): void {
    const update = nativeMetadata(source, initial);
    const previous = this.value.anthropic_metadata ?? {};
    if (previous.stop_details != null && Object.hasOwn(update, "stop_details") &&
        !isDeepStrictEqual(previous.stop_details, update.stop_details)) problem("invalid_upstream_metadata");
    if (update.stop_details != null) this.refused = true;
    // Anthropic's stream accumulator treats a null delta container as no update.
    if (!initial && update.container === null && previous.container != null) delete update.container;
    if (!initial) for (const key of ["stop_reason", "stop_sequence"]) {
      if (Object.hasOwn(source, key) && !(source[key] == null && previous[key] != null)) update[key] = source[key];
    }
    if (Object.keys(update).length) this.value.anthropic_metadata = { ...previous, ...update };
  }

  private updateUsage(usage: any, delta = false): void {
    if (!record(usage)) problem("invalid_upstream_usage");
    const update = clone(usage);
    if (delta) for (const name of ["server_tool_use", "output_tokens_details"]) {
      if (update[name] === null) delete update[name];
    }
    for (const name of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) {
      // Nullable input/cache counters in message_delta mean no new measurement.
      // Retain earlier reported cumulative values, as the native usage observer does.
      if (delta && name !== "output_tokens" && usage[name] === null) { delete update[name]; continue; }
      if (Object.hasOwn(usage, name) && !token(usage[name])) problem("invalid_upstream_usage");
      if (Object.hasOwn(usage, name) && this.nativeUsage !== null && token(this.nativeUsage[name])
        && usage[name] < this.nativeUsage[name]) problem("invalid_upstream_usage");
    }
    this.nativeUsage = { ...(this.nativeUsage ?? {}), ...update };
    this.value.anthropic_usage = clone(this.nativeUsage);
    const { input_tokens: fresh, cache_read_input_tokens: cached, cache_creation_input_tokens: written, output_tokens: output } = this.nativeUsage;
    if ([fresh, cached, written, output].every(token)) {
      const input = fresh + cached + written;
      if (!token(input) || !token(input + output)) problem("invalid_upstream_usage");
      this.value.usage = { input_tokens: input, output_tokens: output, total_tokens: input + output,
        input_tokens_details: { cached_tokens: cached, cache_write_tokens: written } };
    } else this.value.usage = null;
  }
}

/** Nonstream conversion shares exactly the streaming validation/sealing path. */
export function convertNativeMessage(message: JsonObject, options: ResponseTranslationOptions): JsonObject {
  if (!record(message) || !Array.isArray(message.content)) problem("invalid_upstream_event");
  const stream = new ResponsesStream(options);
  const deliver = (event: JsonObject) => {
    stream.push(event);
    if (stream.response.status === "failed" && stream.response.error.code !== "provider_refusal") problem(stream.response.error.code);
  };
  deliver({ type: "message_start", message: { ...message, content: [], stop_reason: null, stop_sequence: null,
    ...(Object.hasOwn(message, "stop_details") ? { stop_details: null } : {}) } });
  for (let index = 0; index < message.content.length; index++) {
    deliver({ type: "content_block_start", index, content_block: message.content[index] });
    deliver({ type: "content_block_stop", index });
  }
  deliver({ type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: message.stop_sequence ?? null,
    ...(Object.hasOwn(message, "stop_details") ? { stop_details: message.stop_details } : {}) },
    ...(message.usage === undefined ? {} : { usage: message.usage }) });
  deliver({ type: "message_stop" });
  if (stream.response.status === "failed") return stream.response;
  stream.finish();
  return stream.response;
}

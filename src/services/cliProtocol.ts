import { createHash } from "node:crypto";
import type { JsonObject } from "./responsesTypes.js";

export class CliBackendError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) { super(message); }
}

export function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as JsonObject)[key])}`).join(",")}}`;
  }
  throw new CliBackendError("invalid_cli_input", "Expected finite JSON values.");
}
export const cliHash = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
export const copy = <T>(value: T): T => JSON.parse(canonical(value));

/** Apply native per-message effort through SDK settings. Substantive system
 * turns retain their original role/order/metadata for the pinned resume adapter. */
export function cliInferenceRequest(body: JsonObject): JsonObject {
  if (!Array.isArray(body.messages)) return body;
  let output = body.output_config;
  const messages = body.messages.filter((message: JsonObject) => {
    if (message?.role !== "system") return true;
    const empty = message.content === undefined || message.content === "" || Array.isArray(message.content) &&
      message.content.every((block: JsonObject) => block?.type === "text" && block.text === "");
    if (Object.keys(message).some(key => !["role", "content", "output_config", "clear_at"].includes(key)) ||
        message.clear_at != null && !["never", "next_user_message"].includes(message.clear_at) ||
        !empty && typeof message.content !== "string" && (!Array.isArray(message.content) ||
          message.content.some((block: JsonObject) => block?.type !== "text" || typeof block.text !== "string"))) {
      throw new CliBackendError("unsupported_cli_system_message", "CLI per-message system turns support native text, cache markers, lifetime and effort controls.");
    }
    if (message.output_config != null) {
      const policy = message.output_config;
      if (typeof policy !== "object" || Array.isArray(policy) || Object.keys(policy).some(key => key !== "effort") ||
          policy.effort !== undefined && policy.effort !== null && !["low", "medium", "high", "xhigh", "max"].includes(policy.effort)) {
        throw new CliBackendError("unsupported_cli_control", "Per-message CLI system controls support native effort labels or null reset.");
      }
      if (Object.hasOwn(policy, "effort")) {
        output = { ...(output ?? {}) };
        if (policy.effort === null) delete output.effort;
        else output.effort = policy.effort;
      }
    }
    return !empty;
  });
  return { ...body, messages, ...(output !== undefined ? { output_config: output } : {}) };
}

export function cliMessages(value: unknown): JsonObject[] {
  if (!Array.isArray(value) || !value.length) throw new CliBackendError("invalid_cli_input", "A nonempty messages array is required.");
  return value.map(message => {
    if (!message || !["user", "assistant", "system"].includes(message.role)) {
      throw new CliBackendError("invalid_cli_input", "CLI Messages accepts user, assistant and native system turns.");
    }
    const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    if (!Array.isArray(content) || content.some(block => !block || typeof block !== "object" || Array.isArray(block) || typeof block.type !== "string")) {
      throw new CliBackendError("invalid_cli_input", "Message content must be text or typed blocks.");
    }
    // Its entire native shape is restored on the private forwarding boundary;
    // preserve string versus blocks, lifetime and per-turn output configuration.
    if (message.role === "system") return copy(message);
    const normalized = copy(content) as JsonObject[];
    // Responses represents direct caller tools and unannotated text without
    // these literal native defaults. Match their equivalent visible history;
    // retain all substantive/unknown metadata, signatures and content bytes.
    for (const block of normalized) {
      if (block.type === "tool_use") {
        if (block.caller?.type === "direct" && Object.keys(block.caller).length === 1) delete block.caller;
        if (block.toolset_name === null) delete block.toolset_name;
      } else if (block.type === "text" && (block.citations === null || Array.isArray(block.citations) && !block.citations.length)) {
        delete block.citations;
      }
    }
    return { role: message.role, content: normalized };
  });
}

export function cliSystem(value: unknown): { blocks: JsonObject[]; text: string } {
  const blocks = value === undefined ? [] : typeof value === "string" ? [{ type: "text", text: value }] : copy(value);
  if (!Array.isArray(blocks) || blocks.some(b => !b || b.type !== "text" || typeof b.text !== "string")) {
    throw new CliBackendError("unsupported_cli_system", "CLI system instructions must be text blocks.");
  }
  return { blocks, text: blocks.map(b => b.text).join("\n\n") };
}

export function cliTools(value: unknown): JsonObject[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new CliBackendError("unsupported_cli_tools", "Expected caller tool definitions.");
  const seen = new Set<string>();
  return value.map(tool => {
    if (!tool || (tool.type !== undefined && tool.type !== "custom") || typeof tool.name !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(tool.name) || seen.has(tool.name) ||
        !tool.input_schema || typeof tool.input_schema !== "object" || Array.isArray(tool.input_schema)) {
      throw new CliBackendError("unsupported_cli_tools", "CLI supports distinct caller-executed tools with JSON input schemas.");
    }
    seen.add(tool.name);
    return copy({ name: tool.name, description: tool.description ?? "", input_schema: tool.input_schema });
  });
}

/** Accumulate the authoritative native stream, never the SDK's per-block assistant envelopes. */
export class CliMessageAccumulator {
  private message?: JsonObject;
  private blocks = new Map<number, JsonObject>();
  private inputs = new Map<number, string>();
  private closedBlocks = new Set<number>();
  private bytes = 0;
  private stopped = false;
  constructor(private readonly model: string) {}
  push(event: JsonObject): void {
    this.bytes += Buffer.byteLength(JSON.stringify(event));
    if (this.bytes > 8 * 1024 * 1024 || this.stopped) throw new CliBackendError("invalid_cli_stream", "CLI stream exceeds its supported boundary.", 502);
    if (event.type === "message_start") {
      if (this.message || !event.message || event.message.model !== this.model) {
        throw new CliBackendError("cli_model_changed", "CLI returned an unexpected model or message.", 502);
      }
      this.message = { ...copy(event.message), content: [] };
    } else if (!this.message) throw new CliBackendError("invalid_cli_stream", "CLI stream started without a message.", 502);
    else if (event.type === "content_block_start") {
      if (!Number.isSafeInteger(event.index) || event.index < 0 || this.blocks.has(event.index) || !event.content_block ||
          event.content_block.type === "text" && typeof event.content_block.text !== "string" ||
          event.content_block.type === "thinking" && (typeof event.content_block.thinking !== "string" ||
            event.content_block.signature !== undefined && typeof event.content_block.signature !== "string")) {
        throw new CliBackendError("invalid_cli_stream", "Invalid CLI block start.", 502);
      }
      this.blocks.set(event.index, copy(event.content_block));
    } else if (event.type === "content_block_delta") {
      const block = this.blocks.get(event.index), delta = event.delta;
      if (!block || !delta || this.closedBlocks.has(event.index)) throw new CliBackendError("invalid_cli_stream", "CLI delta has no open block.", 502);
      if (delta.type === "text_delta" && block.type === "text" && typeof delta.text === "string") block.text += delta.text;
      else if (delta.type === "thinking_delta" && block.type === "thinking" && typeof delta.thinking === "string") block.thinking += delta.thinking;
      else if (delta.type === "signature_delta" && block.type === "thinking" && typeof delta.signature === "string") block.signature = delta.signature;
      else if (delta.type === "input_json_delta" && block.type === "tool_use" && typeof delta.partial_json === "string") this.inputs.set(event.index, (this.inputs.get(event.index) ?? "") + delta.partial_json);
      else throw new CliBackendError("unsupported_cli_delta", "Unsupported CLI content delta.", 502);
    } else if (event.type === "content_block_stop") {
      const block = this.blocks.get(event.index);
      if (!block || this.closedBlocks.has(event.index)) throw new CliBackendError("invalid_cli_stream", "CLI stopped an unknown or closed block.", 502);
      if (this.inputs.has(event.index)) {
        try { block.input = JSON.parse(this.inputs.get(event.index)!); }
        catch { throw new CliBackendError("invalid_cli_tool_input", "CLI returned malformed tool arguments.", 502); }
      }
      if (block.type === "thinking" && !block.signature || block.type === "tool_use" &&
          (!block.input || typeof block.input !== "object" || Array.isArray(block.input))) {
        throw new CliBackendError("invalid_cli_stream", "CLI reasoning or tool state is incomplete.", 502);
      }
      this.closedBlocks.add(event.index);
    } else if (event.type === "message_delta") {
      Object.assign(this.message, copy(event.delta ?? {}));
      this.message.usage = { ...this.message.usage, ...copy(event.usage ?? {}) };
      for (const key of ["context_management", "input_transformations"]) {
        if (Object.hasOwn(event, key) && !(event[key] === null && this.message[key] != null)) this.message[key] = copy(event[key]);
      }
    } else if (event.type === "message_stop") {
      if (this.closedBlocks.size !== this.blocks.size || typeof this.message.stop_reason !== "string" || !this.message.stop_reason) {
        throw new CliBackendError("incomplete_cli_stream", "CLI stopped before every block and terminal reason completed.", 502);
      }
      this.stopped = true;
    }
    else if (event.type !== "ping") throw new CliBackendError("unsupported_cli_event", "Unsupported CLI native event.", 502);
  }
  result(): JsonObject {
    if (!this.message || !this.stopped) throw new CliBackendError("incomplete_cli_stream", "CLI message did not finish.", 502);
    return { ...this.message, content: [...this.blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block) };
  }
}

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ResponsesError, type CompactionCodec, type CompactionState, type JsonObject, type StateContext } from "./responsesTypes.js";

const PREFIX = "ccpc1.";
// The base64 envelope still fits the proxy's 10 MiB HTTP body limit. The limit
// applies to reduced context, including retained image/tool-result content.
const MAX_STATE_BYTES = 7 * 1024 * 1024;
const MAX_TOKEN_CHARS = PREFIX.length + Math.ceil((MAX_STATE_BYTES + 2048) * 4 / 3);

function invalid(): never {
  throw new ResponsesError("invalid_compaction_state", "Compaction state is missing, foreign, changed, or no longer valid for this model and credential.", 409);
}

function validateItemId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || value.length > 256) invalid();
}

function record(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validateState(state: unknown): asserts state is CompactionState {
  if (!record(state) || !Array.isArray(state.messages) || !state.messages.length) invalid();
  for (const message of state.messages) {
    if (!record(message) || !["user", "assistant"].includes(message.role) ||
        !Array.isArray(message.content) || !message.content.length || message.content.some((block: unknown) => !record(block) || typeof block.type !== "string")) invalid();
  }
  if (state.historyTools !== undefined && (!Array.isArray(state.historyTools) || state.historyTools.some((binding: unknown) =>
    !record(binding) || typeof binding.nativeName !== "string" || !binding.nativeName || typeof binding.name !== "string" || !binding.name ||
    !["function", "custom"].includes(binding.kind) || (binding.namespace !== undefined && typeof binding.namespace !== "string")))) invalid();
}

/** Stateless authenticated native history. This is not OpenAI ciphertext, and
 * its separate domain cannot be opened as a signed-thinking ccpr capsule. */
export class ResponsesCompactionStateCodec implements CompactionCodec {
  private readonly key: Buffer;
  constructor(base64Key: string, private readonly ttlSeconds: number, private readonly clock = Date.now) {
    this.key = Buffer.from(base64Key, "base64");
    if (this.key.length !== 32 || this.key.toString("base64") !== base64Key ||
        !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 2592000) {
      throw new Error("Responses compaction requires a canonical base64 32-byte state key and supported TTL");
    }
  }

  private aad(context: StateContext): Buffer {
    if (!context.model || !context.principal || !context.upstream) invalid();
    const fields = ["claude-proxy-responses-compaction-v1", context.model, context.principal, context.upstream];
    if (context.instructionScope !== undefined) {
      if (typeof context.instructionScope !== "string" || !/^[0-9a-f]{64}$/.test(context.instructionScope)) invalid();
      fields.push("developer-hoist-v1", context.instructionScope);
    }
    return Buffer.from(JSON.stringify(fields));
  }

  seal(state: CompactionState, context: StateContext, itemId: string): string {
    validateItemId(itemId);
    validateState(state);
    const serialized = JSON.stringify(state);
    if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) {
      throw new ResponsesError("compaction_state_too_large", "Compacted native context exceeds the supported size.", 502);
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(this.aad(context));
    const payload = Buffer.from(JSON.stringify({ v: 1, issued: Math.floor(this.clock() / 1000), itemId, state }));
    const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
    return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
  }

  open(value: string, context: StateContext, itemId?: string): { itemId: string; state: CompactionState } {
    if (typeof value !== "string" || value.length > MAX_TOKEN_CHARS || !value.startsWith(PREFIX)) invalid();
    if (itemId !== undefined) validateItemId(itemId);
    const encoded = value.slice(PREFIX.length);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) invalid();
    const raw = Buffer.from(encoded, "base64url");
    if (raw.length < 29 || raw.toString("base64url") !== encoded) invalid();
    let payload: JsonObject;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
      decipher.setAAD(this.aad(context));
      decipher.setAuthTag(raw.subarray(12, 28));
      payload = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8"));
    } catch { invalid(); }
    const now = Math.floor(this.clock() / 1000);
    if (!record(payload) || payload.v !== 1 || !Number.isSafeInteger(payload.issued) ||
        payload.issued > now + 60 || now - payload.issued > this.ttlSeconds) invalid();
    validateItemId(payload.itemId);
    if (itemId !== undefined && itemId !== payload.itemId) invalid();
    validateState(payload.state);
    if (Buffer.byteLength(JSON.stringify(payload.state)) > MAX_STATE_BYTES) invalid();
    return { itemId: payload.itemId, state: payload.state };
  }
}

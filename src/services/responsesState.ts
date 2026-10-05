import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { ResponsesError, type JsonObject, type ReasoningCodec, type StateContext } from "./responsesTypes.js";

const PREFIX = "ccpr1.";
const MAX_BLOCK_BYTES = 1024 * 1024;
const MAX_TOKEN_CHARS = Math.ceil((MAX_BLOCK_BYTES + 2048) * 4 / 3);

function invalid(): never {
  throw new ResponsesError("invalid_reasoning_state", "Reasoning state is missing, foreign, changed, or no longer valid for this model and credential.", 409);
}

/** Secrets are used only in a local binding digest; never placed in a capsule. */
export function upstreamStateScope(base: string, credential: { token: string; kind: string }): string {
  return createHash("sha256").update(JSON.stringify([base, credential.kind, credential.token])).digest("hex");
}

function validateBlock(block: unknown): asserts block is JsonObject {
  if (!block || typeof block !== "object" || Array.isArray(block)) invalid();
  const value = block as JsonObject;
  if (value.type === "thinking") {
    if (typeof value.thinking !== "string" || typeof value.signature !== "string" || !value.signature) invalid();
  } else if (value.type === "redacted_thinking") {
    if (typeof value.data !== "string" || !value.data) invalid();
  } else invalid();
}

/** Stateless, bounded AEAD capsules. They are this adapter's format, not OpenAI ciphertext. */
export class ResponsesStateCodec implements ReasoningCodec {
  private readonly key: Buffer;
  constructor(base64Key: string, private readonly ttlSeconds: number, private readonly clock = Date.now) {
    this.key = Buffer.from(base64Key, "base64");
    if (this.key.length !== 32 || this.key.toString("base64") !== base64Key ||
        !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 2592000) {
      throw new Error("Responses adapter requires a canonical base64 32-byte state key and supported TTL");
    }
  }

  private aad(context: StateContext, itemId: string): Buffer {
    if (typeof itemId !== "string" || !itemId || itemId.length > 256 ||
        !context.model || !context.principal || !context.upstream) invalid();
    const fields = ["claude-proxy-responses-v1", context.model, context.principal, context.upstream, itemId];
    // Keep the existing reject-mode capsule contract unchanged. Hoist-mode
    // capsules cannot cross policy modes or a changed effective system prefix.
    if (context.instructionScope !== undefined) {
      if (typeof context.instructionScope !== "string" || !/^[0-9a-f]{64}$/.test(context.instructionScope)) invalid();
      fields.push("developer-hoist-v1", context.instructionScope);
    }
    return Buffer.from(JSON.stringify(fields));
  }

  seal(block: JsonObject, context: StateContext, itemId: string): string {
    validateBlock(block);
    const serialized = JSON.stringify(block);
    if (Buffer.byteLength(serialized) > MAX_BLOCK_BYTES) {
      throw new ResponsesError("reasoning_state_too_large", "Reasoning block exceeds the supported size.", 502);
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(this.aad(context, itemId));
    const payload = Buffer.from(JSON.stringify({ v: 1, issued: Math.floor(this.clock() / 1000), block }));
    const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
    return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
  }

  open(value: string, context: StateContext, itemId: string): JsonObject {
    if (typeof value !== "string" || !value.startsWith(PREFIX) || value.length > MAX_TOKEN_CHARS) invalid();
    const encoded = value.slice(PREFIX.length);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) invalid();
    const raw = Buffer.from(encoded, "base64url");
    if (raw.length < 29 || raw.toString("base64url") !== encoded) invalid();
    let payload: JsonObject;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
      decipher.setAAD(this.aad(context, itemId));
      decipher.setAuthTag(raw.subarray(12, 28));
      payload = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8"));
    } catch { invalid(); }
    const now = Math.floor(this.clock() / 1000);
    if (!payload || payload.v !== 1 || !Number.isSafeInteger(payload.issued) ||
        payload.issued > now + 60 || now - payload.issued > this.ttlSeconds) invalid();
    validateBlock(payload.block);
    if (Buffer.byteLength(JSON.stringify(payload.block)) > MAX_BLOCK_BYTES) invalid();
    return payload.block;
  }
}

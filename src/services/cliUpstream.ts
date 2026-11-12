import http, { type ClientRequest } from "node:http";
import https from "node:https";
import { randomBytes } from "node:crypto";
import type { Request } from "express";
import { ANTHROPIC_BASE_URL, UPSTREAM_TIMEOUT_MS } from "../config.js";
import { resolveUpstreamCredential } from "./settingsService.js";
import { upstreamHeaders, upstreamUrl } from "./nativeRelay.js";
import { upstreamStateScope } from "./responsesState.js";
import { UpstreamDiagnosticsObserver } from "./upstreamDiagnostics.js";
import { UsageObserver, type ObservedUsage } from "./usageObserver.js";

interface CliUpstreamRequest {
  kind: "inference" | "compaction";
  usage: UsageObserver;
  done: Promise<void>;
  outgoing?: ClientRequest;
}

export interface CliUpstreamTurn {
  active: boolean;
  calls: number;
  scope: string;
  model: string;
  observer?: UpstreamDiagnosticsObserver;
  failure?: { status: number; body: Buffer; contentType: string };
  outgoing?: ClientRequest;
  compacting?: boolean;
  inferenceCalls?: number;
  requests?: CliUpstreamRequest[];
  thinkingDisplay?: "updates";
  nativeSystems?: { index: number; marker: string; message: Record<string, unknown>; wireMessage?: Record<string, unknown> | null }[];
  nativeSystemReplay?: boolean;
  importContinuation?: string;
}

/** Sum actual provider calls, including CLI compaction, without double-counting
 * the SDK's cumulative result counters or inventing missing usage. */
export async function cliTurnUsage(turn: CliUpstreamTurn): Promise<ObservedUsage | undefined> {
  const requests = [...(turn.requests ?? [])];
  if (!requests.length) return undefined;
  await Promise.all(requests.map(request => request.done));
  const values = requests.map(request => request.usage.snapshot());
  const fields = ["inputTokens", "outputTokens", "cacheCreationInputTokens", "cacheReadInputTokens",
    "cacheCreation5mTokens", "cacheCreation1hTokens"] as const;
  const result = { usageComplete: values.every(value => value.usageComplete) } as ObservedUsage;
  for (const field of fields) {
    const counts = values.map(value => value[field]);
    const known = counts.filter((value): value is number => value !== null);
    const total = known.length ? known.reduce((sum, value) => sum + value, 0) : null;
    result[field] = total !== null && Number.isSafeInteger(total) ? total : null;
  }
  return result;
}
const clients = new Map<string, CliUpstreamTurn>();
let server: http.Server | undefined;
let starting: Promise<string> | undefined;
const hop = new Set(["connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-authenticate", "proxy-authorization"]);

export async function registerCliUpstream(turn: CliUpstreamTurn): Promise<{ base: string; token: string; close: () => void }> {
  if (!starting) {
    server = http.createServer((req, res) => {
      void (async () => {
        const authorization = req.headers.authorization;
        const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : req.headers["x-api-key"];
        const owner = typeof token === "string" ? clients.get(token) : undefined;
        const path = new URL(req.url ?? "/", "http://localhost");
        const messages = req.method === "POST" && path.pathname === "/v1/messages";
        const auxiliary = req.method === "GET" && path.pathname.startsWith("/v1/models") ||
          req.method === "POST" && path.pathname === "/v1/messages/count_tokens";
        if (!owner || (!messages && !auxiliary)) { res.writeHead(401).end(); return; }
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 10 * 1024 * 1024) { res.writeHead(413).end(); return; }
          chunks.push(Buffer.from(chunk));
        }
        let bytes = Buffer.concat(chunks);
        const body = bytes.length ? JSON.parse(bytes.toString("utf8")) : undefined;
        if (messages && (!owner.active || !owner.compacting && (owner.inferenceCalls ?? 0) > 0 || body?.model !== owner.model)) {
          res.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({ type: "error",
            error: { type: "invalid_request_error", message: "One configured-model inference belongs to each caller turn; CLI compaction is accounted separately." } }));
          return;
        }
        if (messages) { owner.calls++; if (!owner.compacting) owner.inferenceCalls = (owner.inferenceCalls ?? 0) + 1; }
        // Resuming a caller history ends in an unanswered caller turn. The
        // pinned CLI inserts an inert assistant reply before its stdin trigger.
        // Remove only the exact pair associated with this private nonce, on
        // every replay; otherwise the model sees the caller request as finished.
        if (messages && owner.importContinuation && Array.isArray(body?.messages)) {
          const marker = owner.importContinuation;
          const index = body.messages.findIndex((message: Record<string, any>) => message.role === "user" &&
            (message.content === marker || Array.isArray(message.content) && message.content.some((block: Record<string, any>) => block.type === "text" && block.text === marker)));
          if (index >= 0) {
            const message = body.messages[index];
            const remaining = typeof message.content === "string" ? [] : message.content.filter((block: Record<string, any>) => !(block.type === "text" && block.text === marker));
            if (remaining.length) message.content = remaining;
            else body.messages.splice(index, 1);
            const previous = body.messages[index - 1];
            const synthetic = previous?.role === "assistant" && (previous.content === "No response requested." ||
              Array.isArray(previous.content) && previous.content.length === 1 && previous.content[0].type === "text" && previous.content[0].text === "No response requested.");
            if (synthetic) body.messages.splice(index - 1, 1);
            bytes = Buffer.from(JSON.stringify(body));
          }
        }
        // The pinned CLI resume transport renders caller-owned system text via
        // attachment rows but cannot retain their native cache/lifetime fields.
        // Restore ONLY our exact role:system carrier, in place, before any model
        // call (including compaction). Caller-relative lifetimes have already
        // been resolved so the CLI's own helper users cannot expire them early.
        if (messages && owner.nativeSystems?.length && Array.isArray(body?.messages)) {
          let restored = false;
          const seen = new Set<string>();
          body.messages = body.messages.flatMap((message: Record<string, any>) => {
            if (message.role !== "system") return [message];
            const text = typeof message.content === "string" ? message.content : Array.isArray(message.content) ?
              message.content.filter((block: Record<string, any>) => block?.type === "text").map((block: Record<string, any>) => block.text).join("\n") : "";
            const mappings = owner.nativeSystems!.map(value => ({ value, offset: text.indexOf(value.marker) }))
              .filter(value => value.offset >= 0).sort((a, b) => a.offset - b.offset);
            if (!mappings.length) return [message];
            restored = true;
            // Adjacent persisted attachments are coalesced into one system
            // string by the pinned CLI. Expand every owned carrier in order,
            // keeping any unrelated CLI system text at its original position.
            const result: Record<string, unknown>[] = [];
            let cursor = 0;
            for (const { value, offset } of mappings) {
              seen.add(value.marker);
              const source = value.message.content;
              const sourceText = typeof source === "string" ? source : Array.isArray(source) ? source.map(block => block.text).join("\n\n") : "";
              const carrier = value.marker + "\n" + sourceText;
              if (offset < cursor || !text.startsWith(carrier, offset)) throw new Error("invalid_cli_system_carrier");
              const prefix = text.slice(cursor, offset);
              if (prefix.trim()) result.push({ ...message, content: prefix });
              const native = value.wireMessage === undefined ? value.message : value.wireMessage;
              if (native !== null) result.push(native);
              cursor = offset + carrier.length;
            }
            const suffix = text.slice(cursor);
            if (suffix.trim()) result.push({ ...message, content: suffix });
            return result;
          });
          // CLI compact replacement can remove imported attachment rows.
          // Reattach active caller instructions after the new summary; expired
          // caller text is still excluded by the current wireMessage policy.
          if (owner.nativeSystemReplay) for (const mapping of owner.nativeSystems) {
            const native = mapping.wireMessage === undefined ? mapping.message : mapping.wireMessage;
            if (!seen.has(mapping.marker) && native !== null) { body.messages.push(native); restored = true; }
          }
          if (restored) bytes = Buffer.from(JSON.stringify(body));
        }
        // The SDK's option union predates the public updates display. Complete
        // this explicit caller option on the genuine CLI's inference request;
        // internal compaction retains its own thinking/rendering policy.
        if (messages && !owner.compacting && owner.thinkingDisplay === "updates" && body?.thinking &&
            ["adaptive", "enabled"].includes(body.thinking.type) && body.thinking.display !== "updates") {
          body.thinking.display = "updates";
          bytes = Buffer.from(JSON.stringify(body));
        }
        const credential = await resolveUpstreamCredential(() => res.destroyed);
        // Refresh can outlive a cancelled caller. Recheck ownership after the
        // await before creating any provider request, as the HTTP relay does.
        if (res.destroyed || clients.get(String(token)) !== owner || messages && !owner.active) {
          res.destroy(); return;
        }
        if (!credential || upstreamStateScope(ANTHROPIC_BASE_URL, credential) !== owner.scope) {
          res.writeHead(503).end(); return;
        }
        const url = upstreamUrl(ANTHROPIC_BASE_URL, path.pathname.slice(3), path.search);
        const headers = upstreamHeaders(Object.assign(req, { body }) as Request, credential, body);
        if (bytes.length) headers["content-length"] = bytes.length;
        const observer = messages ? new UpstreamDiagnosticsObserver(credential.kind) : undefined;
        if (observer) owner.observer = observer;
        let finishUsage: (() => void) | undefined;
        let receivedResponse = false;
        const record: CliUpstreamRequest | undefined = messages ? {
          kind: owner.compacting ? "compaction" : "inference", usage: new UsageObserver(true),
          done: new Promise<void>(resolve => { finishUsage = resolve; }),
        } : undefined;
        if (record) (owner.requests ??= []).push(record);
        const outgoing = (url.protocol === "https:" ? https : http).request(url, { method: req.method, headers }, incoming => {
          receivedResponse = true;
          void (async () => {
            const status = incoming.statusCode ?? 502;
            observer?.receive(status, incoming.headers);
            res.writeHead(status, Object.fromEntries(Object.entries(incoming.headers).filter(([name]) => !hop.has(name))));
            const errorChunks: Buffer[] = []; let errorSize = 0;
            for await (const chunk of incoming) {
              const value = Buffer.from(chunk);
              observer?.write(value);
              record?.usage.write(value);
              if (messages && status >= 400 && errorSize < 65536) {
                errorChunks.push(value.subarray(0, 65536 - errorSize)); errorSize += value.length;
              }
              if (res.destroyed) break;
              if (!res.write(value)) await new Promise<void>(resolve => { res.once("drain", resolve); res.once("close", resolve); });
            }
            observer?.end();
            record?.usage.end();
            if (messages && status >= 400 && !owner.failure) owner.failure = { status, body: Buffer.concat(errorChunks),
              contentType: String(incoming.headers["content-type"] ?? "application/json") };
            res.end();
          })().catch(() => res.destroy()).finally(() => finishUsage?.());
        });
        if (record) record.outgoing = outgoing;
        if (messages) owner.outgoing = outgoing;
        outgoing.setTimeout(UPSTREAM_TIMEOUT_MS, () => outgoing.destroy());
        outgoing.on("error", () => { finishUsage?.(); if (!res.headersSent) res.writeHead(502).end(); else res.destroy(); });
        outgoing.on("close", () => { if (!receivedResponse) finishUsage?.(); });
        res.on("close", () => { if (!res.writableFinished) outgoing.destroy(); });
        outgoing.end(bytes.length ? bytes : undefined);
      })().catch(() => { if (!res.headersSent) res.writeHead(400).end(); else res.destroy(); });
    });
    starting = new Promise((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", () => {
        server!.unref(); resolve(`http://127.0.0.1:${(server!.address() as { port: number }).port}`);
      });
    });
  }
  const base = await starting, token = randomBytes(32).toString("hex");
  clients.set(token, turn);
  return { base, token, close: () => { turn.outgoing?.destroy(); for (const request of turn.requests ?? []) request.outgoing?.destroy(); clients.delete(token); } };
}

export async function closeCliUpstream(): Promise<void> {
  for (const turn of clients.values()) turn.outgoing?.destroy();
  clients.clear();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server!.close(() => resolve()));
  }
  server = undefined; starting = undefined;
}

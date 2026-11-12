import http, { type ClientRequest } from "node:http";
import https from "node:https";
import { randomBytes } from "node:crypto";
import type { Request } from "express";
import { ANTHROPIC_BASE_URL, UPSTREAM_TIMEOUT_MS } from "../config.js";
import { resolveUpstreamCredential } from "./settingsService.js";
import { upstreamHeaders, upstreamUrl } from "./nativeRelay.js";
import { upstreamStateScope } from "./responsesState.js";
import { UpstreamDiagnosticsObserver } from "./upstreamDiagnostics.js";

export interface CliUpstreamTurn {
  active: boolean;
  calls: number;
  scope: string;
  model: string;
  observer?: UpstreamDiagnosticsObserver;
  failure?: { status: number; body: Buffer; contentType: string };
  outgoing?: ClientRequest;
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
        const bytes = Buffer.concat(chunks);
        const body = bytes.length ? JSON.parse(bytes.toString("utf8")) : undefined;
        if (messages && (!owner.active || owner.calls || body?.model !== owner.model)) {
          res.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({ type: "error",
            error: { type: "invalid_request_error", message: "One configured-model request belongs to each caller turn." } }));
          return;
        }
        if (messages) owner.calls++;
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
        const outgoing = (url.protocol === "https:" ? https : http).request(url, { method: req.method, headers }, incoming => {
          void (async () => {
            const status = incoming.statusCode ?? 502;
            observer?.receive(status, incoming.headers);
            res.writeHead(status, Object.fromEntries(Object.entries(incoming.headers).filter(([name]) => !hop.has(name))));
            const errorChunks: Buffer[] = []; let errorSize = 0;
            for await (const chunk of incoming) {
              const value = Buffer.from(chunk);
              observer?.write(value);
              if (messages && status >= 400 && errorSize < 65536) {
                errorChunks.push(value.subarray(0, 65536 - errorSize)); errorSize += value.length;
              }
              if (res.destroyed) break;
              if (!res.write(value)) await new Promise<void>(resolve => { res.once("drain", resolve); res.once("close", resolve); });
            }
            observer?.end();
            if (messages && status >= 400 && !owner.failure) owner.failure = { status, body: Buffer.concat(errorChunks),
              contentType: String(incoming.headers["content-type"] ?? "application/json") };
            res.end();
          })().catch(() => res.destroy());
        });
        if (messages) owner.outgoing = outgoing;
        outgoing.setTimeout(UPSTREAM_TIMEOUT_MS, () => outgoing.destroy());
        outgoing.on("error", () => { if (!res.headersSent) res.writeHead(502).end(); else res.destroy(); });
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
  return { base, token, close: () => { turn.outgoing?.destroy(); clients.delete(token); } };
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

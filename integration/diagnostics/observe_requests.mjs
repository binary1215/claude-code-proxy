/** Temporary opt-in loopback diagnostic. Never a production/authentication backend. */
import http from 'node:http';
import https from 'node:https';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { summarizeRequest } from './request_shape.mjs';
import { UpstreamDiagnosticsObserver } from '../../dist/services/upstreamDiagnostics.js';
import { UsageObserver } from '../../dist/services/usageObserver.js';

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']);
const MAX_BODY = 10 * 1024 * 1024;
const METHODS = new Map([['/v1/messages', 'POST'], ['/v1/messages/count_tokens', 'POST'], ['/v1/models', 'GET']]);
const PHASES = new Set(['raw_before', 'official_direct', 'official_relay', 'raw_after']);
const match = (value, expected) => {
  if (typeof value !== 'string') return false;
  const actual = Buffer.from(value); const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
};
const validToken = value => typeof value === 'string' && /^[\x21-\x7e]{10,512}$/.test(value);

export function createObservationServer({ oauthToken, proxyKey, proxyTarget, directTarget,
  emit = () => {}, maxRequests = 12, timeoutMs = 60000, offline = false }) {
  if (!validToken(oauthToken) || !validToken(proxyKey)) throw new Error('Invalid diagnostic credentials');
  let direct; let relay;
  try { direct = new URL(directTarget); relay = new URL(proxyTarget); }
  catch { throw new Error('Invalid diagnostic target'); }
  for (const target of [direct, relay]) {
    if (target.username || target.password || target.search || target.hash || target.pathname !== '/') throw new Error('Invalid diagnostic target');
  }
  if (offline) {
    if ([direct, relay].some(t => t.protocol !== 'http:' || t.hostname !== '127.0.0.1')) throw new Error('Offline targets must be loopback');
  } else {
    if (direct.href !== 'https://api.anthropic.com/' || relay.href !== 'http://192.168.0.64:13457/') throw new Error('Live targets are fixed to authorized test destinations');
  }
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 12 ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('Invalid diagnostic limits');
  let phase = 'raw_before'; let count = 0;
  const active = new Set();
  const server = http.createServer({ maxHeaderSize: 32768 }, async (req, res) => {
    if (!match(req.headers.authorization, 'Bearer ' + oauthToken)) {
      res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"diagnostic_auth_required"}'); return;
    }
    if (req.headers['x-api-key'] !== undefined) { res.writeHead(400); res.end(); return; }
    if (String(req.headers.connection || '').split(',').some(h => h.trim().toLowerCase() === 'authorization')) {
      res.writeHead(400); res.end(); return;
    }
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); }
    catch { res.writeHead(400); res.end(); return; }
    if (url.pathname === '/_control/phase' && req.method === 'POST') {
      let body = '';
      try { for await (const chunk of req) { body += chunk; if (body.length > 64) { res.writeHead(413); res.end(); return; } } }
      catch { res.destroy(); return; }
      if (!PHASES.has(body)) { res.writeHead(400); res.end(); return; }
      phase = body; res.writeHead(204); res.end(); return;
    }
    const route = url.pathname.startsWith('/direct/') ? 'direct' : url.pathname.startsWith('/relay/') ? 'relay' : null;
    const endpoint = route ? url.pathname.slice(route.length + 1) : '';
    if (!route || METHODS.get(endpoint) !== req.method) { res.writeHead(404); res.end(); return; }
    if (count >= maxRequests) { res.writeHead(429); res.end(); return; }
    count += 1; const sequence = count; const requestPhase = phase;
    const chunks = []; let bytes = 0;
    try {
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > MAX_BODY) { res.writeHead(413); res.end(); return; }
        chunks.push(chunk);
      }
    } catch { if (!res.destroyed) res.destroy(); return; }
    const body = Buffer.concat(chunks);
    const shape = summarizeRequest({ method: req.method, url: endpoint + url.search, headers: req.headers, body });
    const blocked = new Set([...HOP, ...String(req.headers.connection || '').split(',').map(h => h.trim().toLowerCase())]);
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !blocked.has(name)));
    if (route === 'relay') { headers.authorization = 'Bearer ' + proxyKey; delete headers['x-api-key']; }
    if (req.method === 'POST') headers['content-length'] = body.length;
    const target = new URL(endpoint + url.search, route === 'direct' ? direct : relay);
    const diagnostic = new UpstreamDiagnosticsObserver('oauth'); let usage = new UsageObserver(false, false);
    let finished = false; let received; let timeout; let endReason;
    function finish(reason) {
      if (finished) return; finished = true; clearTimeout(timeout); active.delete(outgoing);
      const record = { phase: requestPhase, sequence, route, shape, diagnostics: diagnostic.snapshot(reason), usage: usage.snapshot() };
      // Sanitizer-produced metadata only. No raw bodies/headers/errors enter the record.
      try { emit(record); } catch { /* Recording must never change the HTTP outcome. */ }
    }
    function fail(reason = 'network_error') {
      if (finished) return;
      finish(reason); received?.destroy(); outgoing.destroy();
      if (res.headersSent) res.destroy(); else { res.writeHead(502); res.end(); }
    }
    const outgoing = (target.protocol === 'https:' ? https : http).request(target, { method: req.method, headers }, incoming => {
      if (finished) { incoming.destroy(); return; }
      received = incoming; const status = incoming.statusCode || 502;
      diagnostic.receive(status, incoming.headers);
      const sse = String(incoming.headers['content-type'] || '').split(';')[0].trim().toLowerCase() === 'text/event-stream';
      usage = new UsageObserver(sse, !incoming.headers['content-encoding'] || incoming.headers['content-encoding'] === 'identity');
      const excluded = new Set([...HOP, ...String(incoming.headers.connection || '').split(',').map(h => h.trim().toLowerCase())]);
      for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined && !excluded.has(name)) res.setHeader(name, value);
      res.statusCode = status; res.flushHeaders();
      incoming.on('data', chunk => { if (finished) return; diagnostic.write(chunk); usage.write(chunk); if (!res.write(chunk)) incoming.pause(); });
      res.on('drain', () => incoming.resume());
      incoming.on('end', () => {
        if (finished) return;
        diagnostic.end(); usage.end();
        endReason = usage.hasError ? 'provider_error' : sse && usage.canObserve && !usage.streamComplete ? 'truncated_stream' : undefined;
        res.end();
      });
      incoming.on('error', () => fail()); incoming.on('aborted', () => fail());
    });
    active.add(outgoing);
    timeout = setTimeout(() => fail('timeout'), timeoutMs); timeout.unref();
    outgoing.on('error', () => fail());
    res.on('finish', () => finish(endReason));
    res.on('close', () => { if (!res.writableFinished && !finished) { finish('cancelled'); received?.destroy(); outgoing.destroy(); } });
    outgoing.end(req.method === 'POST' ? body : undefined);
  });
  server.requestTimeout = timeoutMs; server.headersTimeout = Math.min(timeoutMs, 15000);
  server.on('close', () => { for (const request of active) request.destroy(); });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.DIAGNOSTIC_LIVE_OPT_IN !== '1') throw new Error('Explicit diagnostic opt-in required');
  const server = createObservationServer({ oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    proxyKey: process.env.DIAGNOSTIC_PROXY_KEY, proxyTarget: 'http://192.168.0.64:13457/',
    directTarget: 'https://api.anthropic.com/', emit: record => process.stdout.write(JSON.stringify(record) + '\n') });
  server.listen(0, '127.0.0.1', () => process.stdout.write(JSON.stringify({ ready: true, port: server.address().port }) + '\n'));
  const terminate = () => { server.closeAllConnections(); server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 3000).unref(); };
  process.on('SIGTERM', terminate); process.on('SIGINT', terminate);
}

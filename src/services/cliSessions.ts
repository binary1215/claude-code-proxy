import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, sep, join } from "node:path";
import { randomUUID } from "node:crypto";
import { ANTHROPIC_BASE_URL, CLAUDE_CLI_MAX_SESSIONS, CLAUDE_CLI_RUNTIME_DIR, CLAUDE_CLI_AUTO_COMPACT_WINDOW,
  CLAUDE_CLI_SESSION_TTL_SECONDS, CLAUDE_CLI_WORKER_PATH } from "../config.js";
import { upstreamStateScope } from "./responsesState.js";
import { registerCliUpstream, closeCliUpstream, cliTurnUsage, type CliUpstreamTurn } from "./cliUpstream.js";
import type { ObservedUsage } from "./usageObserver.js";
import { CliBackendError, CliMessageAccumulator, cliHash, cliMessages, cliSystem, cliTools, cliInferenceRequest } from "./cliProtocol.js";
import type { JsonObject } from "./responsesTypes.js";

type Credential = { token: string; kind: "oauth" | "api_key"; stateIdentity?: string };
function validateNextInput(messages: JsonObject[], pending: Set<string>): void {
  const content = messages.flatMap(message => message.content);
  const results = content.filter(block => block.type === "tool_result");
  if (results.length !== pending.size || new Set(results.map(result => result.tool_use_id)).size !== pending.size ||
      results.some(result => !pending.has(result.tool_use_id))) {
    throw new CliBackendError("invalid_cli_tool_history", "Supply one result for every pending caller tool, without foreign or duplicate IDs.");
  }
  for (const result of results) {
    if (result.is_error !== undefined && typeof result.is_error !== "boolean") {
      throw new CliBackendError("invalid_cli_tool_history", "Tool result is_error must be boolean.");
    }
    if (result.content === undefined || typeof result.content === "string") continue;
    if (!Array.isArray(result.content) || result.content.some((block: JsonObject) => {
      if (!block || typeof block !== "object" || Array.isArray(block)) return true;
      if (block.type === "text") return typeof block.text !== "string" || Object.keys(block).some(key => !["type", "text"].includes(key));
      if (block.type === "image" && block.source && typeof block.source === "object" && !Array.isArray(block.source)) {
        return block.source.type !== "base64" || typeof block.source.data !== "string" || typeof block.source.media_type !== "string" ||
          Object.keys(block).some(key => !["type", "source"].includes(key)) ||
          Object.keys(block.source).some(key => !["type", "data", "media_type"].includes(key));
      }
      return true;
    })) {
      throw new CliBackendError("unsupported_cli_tool_result", "CLI tool results support text and base64 image blocks.");
    }
  }
}
class Events {
  values: JsonObject[] = [];
  waiters: { resolve: (value: JsonObject) => void; reject: (error: Error) => void }[] = [];
  error?: Error;
  push(value: JsonObject): void { const waiter = this.waiters.shift(); if (waiter) waiter.resolve(value); else this.values.push(value); }
  fail(error: Error): void { this.error = error; for (const waiter of this.waiters.splice(0)) waiter.reject(error); this.values = []; }
  next(): Promise<JsonObject> {
    if (this.error) return Promise.reject(this.error);
    if (this.values.length) return Promise.resolve(this.values.shift()!);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
}

class Session {
  readonly id = randomUUID();
  readonly queue = new Events();
  readonly upstream: CliUpstreamTurn;
  child?: ChildProcessWithoutNullStreams;
  directory?: string;
  lastUsed = Date.now();
  busy = false;
  closed = false;
  pending = new Set<string>();
  index?: string;
  historyHash?: string;
  historyLength = 0;
  message?: JsonObject;
  turnUsage?: ObservedUsage;
  compactions = 0;
  lastCompaction?: JsonObject;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private readonly ready = new Promise<void>((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
  private completedResolve?: () => void;
  private completedReject?: (error: Error) => void;
  private completed: Promise<void> = Promise.resolve();
  private options = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  private compactWaiter?: { resolve: () => void; reject: (error: Error) => void };
  private forwarding?: { close: () => void };
  private effort: unknown;
  private exitResolve!: () => void;
  readonly exited = new Promise<void>(resolve => { this.exitResolve = resolve; });

  constructor(readonly scope: string, readonly model: string, readonly body: JsonObject, readonly owner: Registry,
    readonly importedHistory?: JsonObject[], readonly origin = "",
    readonly retired: { session: Session; historyHash: string; pending: string[] }[] = []) {
    this.effort = body.output_config?.effort;
    this.upstream = { active: false, calls: 0, scope: "", model };
    if (importedHistory) this.upstream.importContinuation = `[claude-proxy-resume:${randomUUID()}]`;
    this.upstream.nativeSystems = importedHistory?.flatMap((message, index) => message.role === "system" ? [{
      index, marker: `[claude-proxy-system:${cliHash([this.id, index, message])}]`, message,
    }] : []);
    if (body.thinking?.display === "updates") this.upstream.thinkingDisplay = "updates";
    // Rejections can precede the consumer attaching its awaited startup/turn handler.
    void this.ready.catch(() => {});
  }
  async start(credential: Credential): Promise<void> {
    if (this.closed) throw new CliBackendError("cli_session_closed", "The CLI session closed before startup.", 499);
    const root = resolve(CLAUDE_CLI_RUNTIME_DIR);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.directory = mkdtempSync(join(root, "session-"));
    const cwd = join(this.directory, "workspace"), configDir = join(this.directory, "config");
    mkdirSync(cwd, { mode: 0o700 }); mkdirSync(configDir, { mode: 0o700 });
    this.upstream.scope = upstreamStateScope(ANTHROPIC_BASE_URL, credential);
    const forwarding = await registerCliUpstream(this.upstream);
    this.forwarding = forwarding;
    if (this.closed) { forwarding.close(); throw new CliBackendError("cli_session_closed", "The CLI session closed during startup.", 499); }
    // Provider/admin/state secrets remain in the HTTP process. The worker gets
    // only a scoped loopback nonce; real OAuth refresh stays in the HTTP layer.
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      ["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"].includes(name.toUpperCase())));
    this.child = spawn(process.execPath, [resolve(CLAUDE_CLI_WORKER_PATH)], {
      stdio: ["pipe", "pipe", "pipe"], env: environment, windowsHide: true, detached: process.platform !== "win32",
    });
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on("line", line => {
      try {
        if (Buffer.byteLength(line) > 8 * 1024 * 1024) throw new Error();
        const message = JSON.parse(line);
        this.lastUsed = Date.now();
        if (message.type === "ready") this.readyResolve();
        else if (message.type === "native_event") this.queue.push(message.event);
        else if (message.type === "compact_phase") {
          if (this.upstream.compacting && message.active !== true) this.upstream.nativeSystemReplay = true;
          this.upstream.compacting = message.active === true;
          void this.send({ type: "compact_phase_ack", request_id: message.request_id }).catch(error => this.fail(error));
        } else if (message.type === "compact_boundary") {
          this.compactions++; this.lastCompaction = message.compact_metadata;
        } else if (message.type === "compact_result") {
          if (message.success) this.compactWaiter?.resolve();
          else this.compactWaiter?.reject(new CliBackendError("cli_compaction_failed", "CLI compaction failed.", 502));
        }
        else if (message.type === "turn_result") {
          if (!message.success) this.fail(new CliBackendError("cli_inference_failed", "The CLI inference turn failed.", 502));
          else this.completedResolve?.();
        } else if (message.type === "options_applied") {
          this.options.get(message.request_id)?.resolve(); this.options.delete(message.request_id);
        } else if (message.type === "error") {
          const clientError = ["unsupported_options", "unsupported_tool_result", "invalid_tool_result", "unsupported_tool_schema", "invalid_history"].includes(message.code);
          this.fail(new CliBackendError(clientError ? message.code : "cli_inference_failed",
            clientError ? "The requested option, native history or tool result is outside the CLI backend contract." : "The CLI inference worker failed.", clientError ? 400 : 502));
        }
      } catch { this.fail(new CliBackendError("cli_worker_protocol_error", "The CLI worker returned an invalid frame.", 502)); }
    });
    // Drain, never persist or echo raw SDK/CLI stderr.
    this.child.stderr.on("data", () => {});
    this.child.stdin.on("error", () => this.fail(new CliBackendError("cli_worker_closed", "The CLI worker closed.", 502)));
    this.child.on("error", () => this.fail(new CliBackendError("cli_backend_unavailable", "The optional CLI backend is not installed or executable.", 503)));
    this.child.on("close", () => { lines.close(); this.exitResolve(); if (!this.closed) this.fail(new CliBackendError("cli_worker_closed", "The CLI worker closed.", 502)); });
    await this.send({ type: "start", model: this.model, system: cliSystem(this.body.system).text,
      tools: cliTools(this.body.tools), maxTokens: this.body.max_tokens, thinking: this.body.thinking,
      effort: this.effort, cwd, configDir, authMode: "proxy", upstream: forwarding.base,
      ...(CLAUDE_CLI_AUTO_COMPACT_WINDOW ? { autoCompactWindow: CLAUDE_CLI_AUTO_COMPACT_WINDOW } : {}),
      ...(this.importedHistory ? { history: this.importedHistory } : {}),
      ...(this.upstream.nativeSystems?.length ? { systemCarriers: this.upstream.nativeSystems.map(({ index, marker }) => ({ index, marker })) } : {}),
      credential: { kind: "api_key", token: forwarding.token },
      ...(process.env.CLAUDE_CLI_EXECUTABLE ? { cliPath: resolve(process.env.CLAUDE_CLI_EXECUTABLE) } : {}) });
    await this.ready;
  }
  async send(message: JsonObject): Promise<void> {
    if (this.closed || !this.child) throw new CliBackendError("cli_session_closed", "The CLI session is no longer available.", 409);
    await new Promise<void>((resolve, reject) => this.child!.stdin.write(JSON.stringify(message) + "\n", error => error ? reject(error) : resolve()));
  }
  async begin(messages: JsonObject[], effort: unknown): Promise<void> {
    validateNextInput(messages, this.pending);
    this.busy = true; this.lastUsed = Date.now(); this.message = undefined; this.turnUsage = undefined;
    this.upstream.active = true; this.upstream.calls = 0; this.upstream.inferenceCalls = 0; this.upstream.compacting = false;
    this.upstream.requests = [];
    this.upstream.failure = undefined; this.upstream.observer = undefined;
    if (effort !== this.effort) {
      const requestId = randomUUID();
      const applied = new Promise<void>((resolve, reject) => this.options.set(requestId, { resolve, reject }));
      await this.send({ type: "options", effort: effort ?? null, request_id: requestId });
      await applied; this.effort = effort;
    }
    const content = messages.flatMap(message => message.content);
    const results = content.filter(block => block.type === "tool_result");
    const prompt = !messages.length && this.upstream.importContinuation ?
      [{ type: "text", text: this.upstream.importContinuation }] : content.filter(block => block.type !== "tool_result");
    if (this.pending.size) {
      if (results.length !== this.pending.size || new Set(results.map(r => r.tool_use_id)).size !== this.pending.size ||
          results.some(result => !this.pending.has(result.tool_use_id))) {
        throw new CliBackendError("invalid_cli_tool_history", "Supply one result for every pending caller tool.");
      }
      if (prompt.length) await this.send({ type: "prompt", content: prompt, appendToToolTurn: true });
      for (const result of results) await this.send({ type: "tool_result", tool_use_id: result.tool_use_id,
        content: result.content ?? "", is_error: result.is_error === true });
    } else {
      if (results.length) throw new CliBackendError("invalid_cli_tool_history", "There is no matching pending CLI tool call.");
      this.completed = new Promise<void>((resolve, reject) => { this.completedResolve = resolve; this.completedReject = reject; });
      void this.completed.catch(() => {});
      await this.send({ type: "prompt", content: prompt });
    }
  }
  async *events(): AsyncGenerator<JsonObject> {
    const accumulator = new CliMessageAccumulator(this.model);
    while (true) {
      const event = await this.queue.next();
      accumulator.push(event);
      if (event.type === "message_stop") {
        this.message = accumulator.result();
        if (this.message.stop_reason !== "tool_use") await this.completed;
        this.turnUsage = await cliTurnUsage(this.upstream);
        // Wire usage describes this inference's context, as native clients
        // expect. Separate turnUsage includes internal compaction accounting;
        // adding it to wire input_tokens would spuriously trigger compaction.
        yield event; return;
      }
      yield event;
    }
  }
  /** Trusted operator/test control, not a user-message slash-command parser. */
  async compact(instructions?: string): Promise<{ compacted: boolean; metadata?: JsonObject;
    usage?: ObservedUsage; providerCalls: number }> {
    if (this.closed || this.busy || this.pending.size) {
      throw new CliBackendError("cli_session_busy", "Finish the active caller/tool turn before compaction.", 409);
    }
    this.busy = true; this.upstream.active = true; this.upstream.calls = 0;
    this.upstream.inferenceCalls = 0; this.upstream.compacting = false; this.upstream.requests = [];
    this.upstream.failure = undefined; this.upstream.observer = undefined;
    const before = this.compactions;
    const done = new Promise<void>((resolve, reject) => { this.compactWaiter = { resolve, reject }; });
    void done.catch(() => {});
    try {
      await this.send({ type: "compact", ...(instructions ? { instructions } : {}) });
      await done;
      const usage = await cliTurnUsage(this.upstream);
      return { compacted: this.compactions > before, metadata: this.lastCompaction, usage, providerCalls: this.upstream.calls };
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error()); throw error;
    } finally {
      this.compactWaiter = undefined; this.upstream.active = false;
      this.busy = false; this.lastUsed = Date.now();
    }
  }
  commit(messages: JsonObject[]): void {
    if (!this.message) throw new CliBackendError("incomplete_cli_stream", "The CLI message is incomplete.", 502);
    this.pending = new Set(this.message.content.filter((block: JsonObject) => block.type === "tool_use").map((block: JsonObject) => block.id));
    this.upstream.active = false; this.busy = false; this.lastUsed = Date.now();
    const history = cliMessages([...messages, { role: "assistant", content: this.message.content }]);
    this.historyHash = cliHash(history); this.historyLength = history.length;
    this.index = cliHash([this.scope, history]);
    const matches = this.owner.index.get(this.index) ?? new Set<Session>();
    matches.add(this); this.owner.index.set(this.index, matches);
    for (const old of this.retired.splice(0)) {
      if (!old.session.closed && !old.session.busy && old.session.historyHash === old.historyHash &&
          old.session.pending.size === old.pending.length && old.pending.every(id => old.session.pending.has(id))) old.session.close();
    }
  }
  fail(error: Error): void {
    if (this.closed) return;
    this.readyReject(error); this.completedReject?.(error); this.queue.fail(error);
    this.compactWaiter?.reject(error);
    for (const waiter of this.options.values()) waiter.reject(error);
    this.options.clear(); this.close();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.upstream.active = false; this.forwarding?.close();
    if (this.index) {
      const matches = this.owner.index.get(this.index);
      matches?.delete(this);
      if (!matches?.size) this.owner.index.delete(this.index);
    }
    this.owner.sessions.delete(this.id);
    const child = this.child;
    if (child && child.exitCode === null && !child.signalCode) {
      if (child.stdin.writable) child.stdin.end(JSON.stringify({ type: "close" }) + "\n");
      const stop = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode) return;
        try { process.platform === "win32" ? child.kill("SIGTERM") : process.kill(-child.pid!, "SIGTERM"); } catch { /* Already exited. */ }
      }, 1000);
      stop.unref();
      const force = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode) return;
        try {
          if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
          else process.kill(-child.pid!, "SIGKILL");
        } catch { /* Owned worker already exited. */ }
      }, 2500);
      force.unref();
      child.once("close", () => { clearTimeout(stop); clearTimeout(force); this.removeDirectory(); });
    } else { this.removeDirectory(); this.exitResolve(); }
  }
  private removeDirectory(): void {
    if (!this.directory) return;
    const root = resolve(CLAUDE_CLI_RUNTIME_DIR), target = resolve(this.directory);
    // Delete only the exact mkdtemp directory owned by this session.
    if (target.startsWith(root + sep) && target !== root) {
      try { rmSync(target, { recursive: true, force: true }); } catch { /* Open handles may delay optional cleanup. */ }
    }
  }
}

class Registry {
  readonly sessions = new Map<string, Session>();
  readonly index = new Map<string, Set<Session>>();
  private timer?: NodeJS.Timeout;
  async acquire(body: JsonObject, principal: string, credential: Credential, signal?: AbortSignal): Promise<{
    session: Session; messages: JsonObject[]; detach: () => void;
  }> {
    if (signal?.aborted) throw new CliBackendError("request_cancelled", "Request cancelled.", 499);
    body = cliInferenceRequest(body);
    const messages = cliMessages(body.messages), system = cliSystem(body.system), tools = cliTools(body.tools);
    if ([...messages].reverse().find(message => message.role !== "system")?.role !== "user") {
      throw new CliBackendError("unsupported_cli_prefill", "A CLI caller turn must end in user input, optionally followed by native system context.");
    }
    if (body.tool_choice && !["auto", "none"].includes(body.tool_choice.type)) {
      throw new CliBackendError("unsupported_cli_control", "CLI tool choice supports auto or none.");
    }
    if (body.tool_choice?.disable_parallel_tool_use === true) {
      throw new CliBackendError("unsupported_cli_control", "The CLI SDK does not expose serial-only model tool choice. Use the HTTP backend for this control.");
    }
    if (body.temperature !== undefined || body.top_p !== undefined || body.top_k !== undefined || body.stop_sequences?.length) {
      throw new CliBackendError("unsupported_cli_control", "Sampling and stop-sequence overrides require the HTTP backend.");
    }
    if (body.output_config !== undefined && (!body.output_config || typeof body.output_config !== "object" ||
        Object.keys(body.output_config).some(key => key !== "effort") ||
        body.output_config.effort !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(body.output_config.effort))) {
      throw new CliBackendError("unsupported_cli_control", "CLI output configuration supports the documented effort labels.");
    }
    const scope = cliHash([principal, upstreamStateScope(ANTHROPIC_BASE_URL, credential), body.model,
      system.blocks, tools, body.max_tokens, body.thinking ?? null, body.tool_choice ?? null]);
    const origin = cliHash([principal, upstreamStateScope(ANTHROPIC_BASE_URL, credential)]);
    let pivot = messages.length - 1;
    while (pivot >= 0 && messages[pivot].role !== "assistant") pivot--;
    const history = messages.slice(0, pivot + 1), next = messages.slice(pivot + 1);
    const newSystem = next.some(message => message.role === "system");
    let session: Session | undefined;
    let imported = false;
    if (history.length && !newSystem) {
      const key = cliHash([scope, history]);
      const matches = this.index.get(key);
      session = matches && [...matches].find(value => !value.closed && !value.busy);
      if (!session && matches?.size) throw new CliBackendError("cli_session_busy", "Matching CLI conversations already have active requests.", 409);
      if (session) {
        validateNextInput(next, session.pending);
        matches!.delete(session);
        if (!matches!.size) this.index.delete(key);
        session.index = undefined;
      }
    }
    if (!session) {
      imported = history.length > 0 || newSystem;
      if (!imported) {
      validateNextInput(next, new Set());
      }
      if (this.sessions.size >= CLAUDE_CLI_MAX_SESSIONS) {
        const idle = [...this.sessions.values()].filter(value => !value.busy && !value.pending.size)
          .sort((a, b) => a.lastUsed - b.lastUsed)[0];
        if (idle) idle.close();
        else throw new CliBackendError("cli_capacity", "All CLI sessions currently have active or pending caller work.", 503);
      }
      const retired: { session: Session; historyHash: string; pending: string[] }[] = [];
      if (imported) for (const old of this.sessions.values()) {
        if (old.closed || old.busy || !old.pending.size || old.origin !== origin || !old.historyHash || old.historyLength >= messages.length) continue;
        if (cliHash(messages.slice(0, old.historyLength)) !== old.historyHash) continue;
        const results = messages.slice(old.historyLength).flatMap(message => message.content)
          .filter(block => block.type === "tool_result").map(block => block.tool_use_id);
        if ([...old.pending].every(id => results.includes(id))) retired.push({ session: old, historyHash: old.historyHash, pending: [...old.pending] });
      }
      session = new Session(scope, body.model, { ...body, system: system.blocks, tools: body.tool_choice?.type === "none" ? [] : tools }, this,
        imported ? messages : undefined, origin, retired);
      this.sessions.set(session.id, session);
      session.busy = true;
    }
    const owned = session;
    const abort = () => owned.fail(new CliBackendError("request_cancelled", "Request cancelled.", 499));
    signal?.addEventListener("abort", abort, { once: true });
    const detach = () => signal?.removeEventListener("abort", abort);
    try {
      if (signal?.aborted) { abort(); throw new CliBackendError("request_cancelled", "Request cancelled.", 499); }
      if (!session.child) await session.start(credential);
    } catch (error) { detach(); session.close(); throw error; }
    if (!this.timer) {
      this.timer = setInterval(() => {
        for (const value of this.sessions.values()) {
          if (!value.busy && Date.now() - value.lastUsed > CLAUDE_CLI_SESSION_TTL_SECONDS * 1000) {
            value.fail(new CliBackendError("cli_session_expired", "The idle CLI session expired.", 409));
          }
        }
      }, 30000);
      this.timer.unref();
    }
    // Native next_user_message refers to CALLER turns. Resume and compaction
    // add SDK helper users: do not let those consume a caller instruction's
    // lifetime. Render active text for this request; omit it only after a real
    // later caller user, while retaining any independent output policy.
    for (const context of session.upstream.nativeSystems ?? []) {
      if (context.message.clear_at !== "next_user_message") { context.wireMessage = context.message; continue; }
      const expired = messages.slice(context.index + 1).some(message => message.role === "user");
      context.wireMessage = !expired ? { ...context.message, clear_at: "never" } :
        context.message.output_config && Object.keys(context.message.output_config as JsonObject).length ?
          { role: "system", content: [], output_config: context.message.output_config } : null;
    }
    try { await session.begin(imported ? [] : next, body.output_config?.effort); }
    catch (error) { detach(); session.fail(error instanceof Error ? error : new Error()); throw error; }
    return { session, messages, detach };
  }
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const owned = [...this.sessions.values()];
    for (const session of owned) session.fail(new CliBackendError("cli_session_closed", "The CLI backend closed.", 503));
    await Promise.all(owned.map(session => session.exited));
  }
}
const registry = new Registry();
export const acquireCliSession = (body: JsonObject, principal: string, credential: Credential, signal?: AbortSignal) => registry.acquire(body, principal, credential, signal);
export const cliSessionCount = (): number => registry.sessions.size;
export async function closeCliSessions(): Promise<void> { await registry.close(); await closeCliUpstream(); }

import { createInterface } from 'node:readline';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { query, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  AsyncQueue, MCP_SERVER, NativeEventTransformer, ToolBroker, WorkerError,
  createToolRegistry, isRecord, nativeThinkingToSdk, nativeToolName, sdkEnvironment, validateEffort,
} from './helpers.mjs';
import { nativeHistoryEntries, nativeHistoryStore } from './history.mjs';

const ERROR_MESSAGES = {
  invalid_ipc: 'Invalid worker command.',
  invalid_start: 'Invalid CLI backend configuration.',
  invalid_history: 'The imported native history must preserve roles and completed caller tool pairs.',
  invalid_tools: 'Caller tool definitions are invalid.',
  unsupported_tool_schema: 'The CLI backend requires object tool schemas.',
  unsupported_options: 'A requested option is unsupported by the pinned CLI SDK.',
  unsupported_tool_result: 'A caller tool result has no lossless supported MCP representation.',
  invalid_tool_result: 'Caller tool result is invalid.',
  unknown_tool_result: 'Caller tool result does not match an outstanding native tool call.',
  tool_id_mismatch: 'Native tool correlation failed.',
  unknown_tool: 'The CLI requested a tool outside the caller tool set.',
  invalid_tool_input: 'The CLI tool input did not match the caller-tool envelope.',
  invalid_native_event: 'The CLI emitted an invalid native event.',
  tool_cancelled: 'The CLI tool wait was cancelled.',
  retry_disabled: 'The CLI attempted a retry; this worker requires a new explicit request.',
  fallback_disabled: 'The CLI attempted a model fallback.',
  turn_in_progress: 'The previous CLI turn is still in progress.',
  no_active_tool_turn: 'Additional tool-turn input requires an active CLI turn.',
  worker_not_ready: 'The CLI worker is not ready.',
  worker_closed: 'The CLI worker has closed.',
  startup_failed: 'The CLI worker could not initialize.',
  inference_failed: 'The CLI inference turn failed.',
  options_failed: 'The CLI could not apply the requested session options.',
  compact_snapshot_failed: 'The CLI did not return a complete compacted conversation.',
};

function validateStart(start) {
  if (typeof start.model !== 'string' || !start.model || typeof start.system !== 'string'
      || typeof start.cwd !== 'string' || !isAbsolute(start.cwd)
      || typeof start.configDir !== 'string' || !isAbsolute(start.configDir)
      || !Number.isSafeInteger(start.maxTokens) || start.maxTokens < 1) throw new WorkerError('invalid_start');
  if (start.cliPath !== undefined && (typeof start.cliPath !== 'string' || !isAbsolute(start.cliPath))) throw new WorkerError('invalid_start');
  let url;
  try { url = new URL(start.upstream); } catch { throw new WorkerError('invalid_start'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new WorkerError('invalid_start');
  validateEffort(start.effort);
  if (start.autoCompactWindow !== undefined && (!Number.isSafeInteger(start.autoCompactWindow) || start.autoCompactWindow < 100000 || start.autoCompactWindow > 1000000)) throw new WorkerError('invalid_start');
  nativeThinkingToSdk(start.thinking);
}

export function createCallerMcpServer(registry, broker) {
  const server = new McpServer({ name: 'claude-proxy-caller-tools', version: '1.0.0' }, { capabilities: { tools: {} } });
  // The low-level handlers retain the caller's full JSON Schema instead of translating through Zod.
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: registry.definitions }));
  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => broker.call(request.params.name, request.params.arguments, extra.signal));
  server.server.onerror = () => {}; // Never log raw MCP errors or tool content.
  return server;
}

/** Exported only for deterministic fake-SDK tests; production uses the real pinned SDK. */
export class CliWorker {
  constructor({ emit, queryFactory = query, onClosed = () => {} }) {
    this.emit = emit;
    this.queryFactory = queryFactory;
    this.onClosed = onClosed;
    this.queue = new AsyncQueue();
    this.closed = false;
    this.started = false;
    this.ready = false;
    this.turnInProgress = false;
    this.compacting = false;
    this.compactCommandInProgress = false;
    this.compactAcknowledgements = new Map();
  }
  async handle(message) {
    if (!isRecord(message) || typeof message.type !== 'string') throw new WorkerError('invalid_ipc');
    if (message.type === 'close') { this.close(); return; }
    if (this.closed) throw new WorkerError('worker_closed');
    if (message.type === 'start') { await this.start(message); return; }
    if (!this.ready) throw new WorkerError('worker_not_ready');
    switch (message.type) {
      case 'prompt': {
        if (message.appendToToolTurn !== undefined && typeof message.appendToToolTurn !== 'boolean') throw new WorkerError('invalid_ipc');
        const appendToToolTurn = message.appendToToolTurn === true;
        if (appendToToolTurn && !this.turnInProgress) throw new WorkerError('no_active_tool_turn');
        if (!appendToToolTurn && this.turnInProgress) throw new WorkerError('turn_in_progress');
        if (typeof message.content !== 'string' && !Array.isArray(message.content)) throw new WorkerError('invalid_ipc');
        // There is intentionally no assistant-history hydration or local tool execution.
        if (!appendToToolTurn) this.turnInProgress = true;
        this.queue.push({ type: 'user', message: { role: 'user', content: message.content }, parent_tool_use_id: null, client_composed: true,
          ...(appendToToolTurn ? { priority: 'next' } : {}) });
        return;
      }
      case 'tool_result': this.broker.deliver(message); return;
      case 'compact_phase_ack': {
        if (typeof message.request_id !== 'string') throw new WorkerError('invalid_ipc');
        const pending = this.compactAcknowledgements.get(message.request_id);
        if (!pending) throw new WorkerError('invalid_ipc');
        this.compactAcknowledgements.delete(message.request_id);
        pending.resolve();
        return;
      }
      case 'compact': {
        if (this.turnInProgress) throw new WorkerError('turn_in_progress');
        if (message.instructions !== undefined && typeof message.instructions !== 'string') throw new WorkerError('invalid_ipc');
        this.turnInProgress = true;
        this.compactCommandInProgress = true;
        // Trusted broker command only. External prompts always set client_composed.
        this.queue.push({ type: 'user', message: { role: 'user', content: `/compact${message.instructions ? ` ${message.instructions}` : ''}` }, parent_tool_use_id: null });
        return;
      }
      case 'options': {
        if (typeof message.request_id !== 'string' || !message.request_id) throw new WorkerError('invalid_ipc');
        validateEffort(message.effort);
        // Live effort is the SDK's documented flag-settings path, never a prompt mutation.
        try { await this.query.applyFlagSettings({ effortLevel: message.effort ?? null }); }
        catch { throw new WorkerError('options_failed'); }
        if (!this.closed) this.emit({ type: 'options_applied', request_id: message.request_id });
        return;
      }
      default: throw new WorkerError('invalid_ipc');
    }
  }
  async start(start) {
    if (this.started) throw new WorkerError('invalid_start');
    this.started = true;
    validateStart(start);
    const registry = createToolRegistry(start.tools);
    this.registry = registry;
    const env = sdkEnvironment(start);
    const imported = start.history === undefined ? undefined : nativeHistoryEntries(start.history, { model: start.model, cwd: start.cwd, systemCarriers: start.systemCarriers, compactOnly: start.compactOnly === true });
    this.compactOnly = start.compactOnly === true;
    this.sessionStore = imported ? nativeHistoryStore(imported, { capture: this.compactOnly }) : undefined;
    this.imported = imported;
    this.historicalTools = new Map((start.history ?? []).flatMap(message => Array.isArray(message.content) ? message.content : [])
      .filter(block => block.type === 'tool_use' && typeof block.name === 'string').map(block => [nativeToolName(block.name), block.name]));
    this.broker = new ToolBroker(registry, message => this.emitUnlessClosed(message), error => this.fail(error));
    this.transformer = new NativeEventTransformer(registry, this.broker);
    this.mcpServer = createCallerMcpServer(registry, this.broker);
    const preToolUse = async input => {
      try { return this.broker.preToolUse(input); }
      catch (error) { this.fail(error); throw error; }
    };
    this.abortController = new AbortController();
    try {
      this.query = this.queryFactory({
        prompt: this.queue,
        options: {
          model: start.model,
          ...(start.cliPath === undefined ? {} : { pathToClaudeCodeExecutable: start.cliPath }),
          cwd: start.cwd,
          env,
          abortController: this.abortController,
          systemPrompt: { type: 'preset', preset: 'claude_code', append: start.system },
          tools: [],
          skills: [],
          plugins: [],
          settingSources: [],
          strictMcpConfig: true,
          persistSession: Boolean(imported),
          ...(imported ? { resume: imported.sessionId, sessionStore: this.sessionStore,
            ...(this.compactOnly ? { sessionStoreFlush: 'eager' } : {}) } : {}),
          enableFileCheckpointing: false,
          includePartialMessages: true,
          // Per-message guards protect every external prompt and allow only
          // the broker's own /compact control to dispatch as a CLI command.
          verbatimPrompts: false,
          permissionMode: 'default',
          settings: {
            disableClaudeAiConnectors: true,
            disableBundledSkills: true,
            autoMemoryEnabled: false,
            enableAllProjectMcpServers: false,
            fallbackModel: [],
            autoCompactEnabled: true,
            ...(start.autoCompactWindow ? { autoCompactWindow: start.autoCompactWindow } : {}),
            idleCompaction: false,
            precomputeCompactionEnabled: false,
          },
          ...(start.effort == null ? {} : { effort: start.effort }),
          ...(start.thinking === undefined ? {} : { thinking: nativeThinkingToSdk(start.thinking) }),
          mcpServers: registry.definitions.length ? {
            [MCP_SERVER]: { type: 'sdk', name: MCP_SERVER, instance: this.mcpServer, timeout: 2_147_483_647 },
          } : {},
          hooks: {
            PreToolUse: [{ hooks: [preToolUse], timeout: 30, onFailure: 'block' }],
            PreCompact: [{ hooks: [async () => { await this.compactPhase(true); return {}; }], timeout: 30, onFailure: 'block' }],
            PostCompact: [{ hooks: [async input => {
              if (typeof input.compact_summary === 'string') this.compactSummary = input.compact_summary;
              await this.compactPhase(false); return {};
            }], timeout: 30, onFailure: 'block' }],
          },
          // A supported allow hook normally resolves permission first. If the CLI still asks,
          // use the exact native ID once more, never name/order association.
          canUseTool: async (name, input, options) => {
            const result = await preToolUse({ tool_name: name, tool_input: input, tool_use_id: options.toolUseID });
            return { behavior: 'allow', updatedInput: result.hookSpecificOutput.updatedInput };
          },
          stderr: () => {},
        },
      });
      this.consumption = this.consume();
      await this.query.initializationResult();
      if (this.closed) return;
      this.ready = true;
      this.emit({ type: 'ready' });
    } catch {
      this.fail(new WorkerError('startup_failed'));
    }
  }
  async compactPhase(active) {
    if (this.closed) throw new WorkerError('worker_closed');
    this.compacting = active;
    const request_id = randomUUID();
    const acknowledgement = new Promise((resolve, reject) => this.compactAcknowledgements.set(request_id, { resolve, reject }));
    this.emit({ type: 'compact_phase', active, request_id });
    await acknowledgement;
  }
  async consume() {
    try {
      for await (const message of this.query) {
        if (this.closed) break;
        if (message.type === 'stream_event') {
          // Compaction is an internal model call, never an ordinary assistant reply.
          if (this.compacting || this.compactCommandInProgress) continue;
          if (message.event?.type === 'error') throw new WorkerError('inference_failed');
          for (const event of this.transformer.transform(message.event)) this.emitUnlessClosed({ type: 'native_event', event });
        } else if (message.type === 'result') {
          const success = message.subtype === 'success' && !message.is_error;
          this.turnInProgress = false;
          const compact = this.compactCommandInProgress || message.local_command === 'compact';
          this.compactCommandInProgress = false;
          const snapshot = compact && success && this.compactOnly ? await this.compactedHistory(message.session_id) : undefined;
          this.emitUnlessClosed({ type: compact ? 'compact_result' : 'turn_result', success, session_id: message.session_id,
            ...(snapshot ? { messages: snapshot, summary: this.compactSummary } : {}) });
          if (!success) { this.fail(new WorkerError('inference_failed')); break; }
        } else if (message.type === 'system' && message.subtype === 'compact_boundary') {
          const source = message.compact_metadata ?? {};
          const compact_metadata = {};
          if (['manual', 'auto'].includes(source.trigger)) compact_metadata.trigger = source.trigger;
          for (const key of ['pre_tokens', 'post_tokens', 'duration_ms', 'cumulative_dropped_tokens']) {
            if (typeof source[key] === 'number' && Number.isFinite(source[key]) && source[key] >= 0) compact_metadata[key] = source[key];
          }
          this.emitUnlessClosed({ type: 'compact_boundary', compact_metadata });
        } else if (message.type === 'system' && message.subtype === 'status') {
          if (message.compact_result === 'failed' && this.compacting) await this.compactPhase(false);
          if (message.status === 'compacting' || message.compact_result !== undefined) {
            this.emitUnlessClosed({ type: 'compact_status', status: message.status === 'compacting' ? 'compacting' : null,
              ...(['success', 'failed'].includes(message.compact_result) ? { compact_result: message.compact_result } : {}) });
          }
        } else if (message.type === 'system' && message.subtype === 'api_retry') {
          throw new WorkerError('retry_disabled');
        } else if (message.type === 'system' && message.subtype === 'model_refusal_fallback') {
          throw new WorkerError('fallback_disabled');
        }
        // Assistant envelopes are per-content-block, not authoritative complete messages.
        // All other SDK notices/stderr are intentionally excluded from IPC.
      }
      if (!this.closed) this.fail(new WorkerError('inference_failed'));
    } catch (error) {
      if (!this.closed) this.fail(error instanceof WorkerError ? error : new WorkerError('inference_failed'));
    }
  }
  async compactedHistory(sessionId) {
    if (!this.sessionStore || !this.compactSummary) throw new WorkerError('compact_snapshot_failed');
    const rows = await getSessionMessages(sessionId, { sessionStore: this.sessionStore });
    const summaryIndex = rows.findLastIndex(row => row.isCompactSummary === true);
    if (summaryIndex < 0) throw new WorkerError('compact_snapshot_failed');
    const importedIds = new Set(this.imported.entries.map(entry => entry.uuid));
    return rows.slice(summaryIndex).filter(row => {
      if (row.isCompletedLocalCommand) return false;
      // The CLI manufactures this inert assistant only for user-ended resume.
      // It is not caller history and must not mark their latest task finished.
      const content = row.message?.content;
      return !(row.type === 'assistant' && !importedIds.has(row.uuid) &&
        (content === 'No response requested.' || Array.isArray(content) && content.length === 1 &&
          content[0]?.type === 'text' && content[0].text === 'No response requested.'));
    }).map(row => {
      const source = row.message;
      if (!isRecord(source) || !['user', 'assistant'].includes(source.role)) throw new WorkerError('compact_snapshot_failed');
      const content = typeof source.content === 'string' ? [{ type: 'text', text: source.content }] : structuredClone(source.content);
      if (!Array.isArray(content)) throw new WorkerError('compact_snapshot_failed');
      if (row.isCompactSummary === true) {
        // The persisted CLI wrapper points at its ephemeral local transcript.
        // Export the exact genuine model summary, not instructions to read a
        // deleted file. The remaining rows below still preserve the CLI tail.
        if (!content.filter(block => block.type === 'text').map(block => block.text).join('\n').includes(this.compactSummary)) {
          throw new WorkerError('compact_snapshot_failed');
        }
        return { role: 'user', content: [{ type: 'text', text: this.compactSummary }] };
      }
      return { role: source.role, content: content.map(block => {
        if (block.type !== 'tool_use') return block;
        const name = this.registry.byNative.get(block.name)?.original ?? this.historicalTools.get(block.name);
        if (!name || !isRecord(block.input?.input)) throw new WorkerError('compact_snapshot_failed');
        return { ...block, name, input: block.input.input };
      }) };
    });
  }
  emitUnlessClosed(message) { if (!this.closed) this.emit(message); }
  fail(error) {
    if (this.closed) return;
    const code = error instanceof WorkerError && Object.hasOwn(ERROR_MESSAGES, error.code) ? error.code : 'inference_failed';
    // Stop the real engine before rejecting any pending MCP handler promises.
    this.close();
    this.emit({ type: 'error', code, message: ERROR_MESSAGES[code] });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    try { this.query?.close(); } catch {}
    this.abortController?.abort();
    this.broker?.close();
    for (const pending of this.compactAcknowledgements.values()) pending.reject(new WorkerError('worker_closed'));
    this.compactAcknowledgements.clear();
    this.queue.close();
    void this.mcpServer?.close().catch(() => {});
    this.onClosed();
  }
}

function main() {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  const worker = new CliWorker({
    emit: message => process.stdout.write(`${JSON.stringify(message)}\n`),
    onClosed: () => { input.close(); process.stdin.pause(); },
  });
  let chain = Promise.resolve();
  input.on('line', line => {
    let message;
    try { message = JSON.parse(line); }
    catch { worker.fail(new WorkerError('invalid_ipc')); return; }
    // Cancellation must also work while initialization/options await a control reply.
    if (message?.type === 'close') { worker.close(); return; }
    chain = chain.then(() => worker.handle(message)).catch(error => worker.fail(error));
  });
  input.on('close', () => worker.close());
  process.on('uncaughtException', () => worker.fail(new WorkerError('inference_failed')));
  process.on('unhandledRejection', () => worker.fail(new WorkerError('inference_failed')));
  process.on('SIGTERM', () => worker.close());
  process.on('SIGINT', () => worker.close());
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

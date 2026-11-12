import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const MCP_SERVER = 'caller';
export const BROKER_ID = '__claude_proxy_tool_use_id';
export const MAX_MCP_RESULT_CHARS = 500_000;
export const localToolName = name => `t_${createHash('sha256').update(name).digest('hex').slice(0, 24)}`;
export const nativeToolName = name => `mcp__${MCP_SERVER}__${localToolName(name)}`;

export class WorkerError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A single consumer queue; closing it never fabricates another prompt. */
export class AsyncQueue {
  #items = [];
  #waiting = [];
  #closed = false;
  push(value) {
    if (this.#closed) throw new WorkerError('worker_closed');
    const waiting = this.#waiting.shift();
    if (waiting) waiting({ value, done: false });
    else this.#items.push(value);
  }
  close() {
    this.#closed = true;
    this.#items.length = 0;
    for (const resolve of this.#waiting.splice(0)) resolve({ done: true, value: undefined });
  }
  next() {
    if (this.#items.length) return Promise.resolve({ value: this.#items.shift(), done: false });
    if (this.#closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise(resolve => this.#waiting.push(resolve));
  }
  [Symbol.asyncIterator]() { return this; }
}

/** Relocate JSON-pointer references, preserving nested schema-resource $id scopes. */
export function embedInputSchema(schema) {
  if (!isRecord(schema)) throw new WorkerError('unsupported_tool_schema');
  const maps = new Set(['properties', 'patternProperties', 'definitions', '$defs', 'dependentSchemas']);
  const singles = new Set(['not', 'if', 'then', 'else', 'items', 'contains', 'additionalProperties', 'unevaluatedProperties', 'additionalItems', 'propertyNames', 'unevaluatedItems', 'contentSchema']);
  const arrays = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
  function relocate(value, separateResource = false) {
    if (!isRecord(value)) return value;
    const ownResource = separateResource || (typeof value.$id === 'string' && value.$id.length > 0);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (!ownResource && ['$ref', '$dynamicRef', '$recursiveRef'].includes(key) && typeof item === 'string') {
        if (item === '#') return [key, '#/properties/input'];
        if (item.startsWith('#/')) return [key, `#/properties/input${item.slice(1)}`];
      }
      if ((maps.has(key) || key === 'dependencies') && isRecord(item)) {
        return [key, Object.fromEntries(Object.entries(item).map(([name, child]) => [name, relocate(child, ownResource)]))];
      }
      if ((arrays.has(key) || key === 'items') && Array.isArray(item)) return [key, item.map(child => relocate(child, ownResource))];
      if (singles.has(key)) return [key, relocate(item, ownResource)];
      // Defaults/examples/const/enum and unknown extension values are data, not schema locations.
      return [key, structuredClone(item)];
    }));
  }
  return {
    type: 'object',
    properties: { input: relocate(schema) },
    required: ['input'],
    // PreToolUse inserts a broker-owned ID outside the caller's original schema.
    additionalProperties: true,
  };
}

export function createToolRegistry(tools) {
  if (!Array.isArray(tools)) throw new WorkerError('invalid_start');
  const byNative = new Map();
  const byLocal = new Map();
  const byOriginal = new Map();
  for (const tool of tools) {
    if (!isRecord(tool) || typeof tool.name !== 'string' || !tool.name || byOriginal.has(tool.name)) {
      throw new WorkerError('invalid_tools');
    }
    const local = localToolName(tool.name);
    const native = nativeToolName(tool.name);
    const entry = {
      original: tool.name, local, native,
      definition: {
        name: local,
        description: `Caller tool ${JSON.stringify(tool.name)}. Put its original arguments in input.${typeof tool.description === 'string' ? `\n${tool.description}` : ''}`,
        inputSchema: embedInputSchema(tool.input_schema),
        _meta: { 'anthropic/alwaysLoad': true, 'anthropic/maxResultSizeChars': MAX_MCP_RESULT_CHARS },
      },
    };
    if (byLocal.has(local)) throw new WorkerError('invalid_tools');
    byLocal.set(local, entry);
    byNative.set(native, entry);
    byOriginal.set(tool.name, entry);
  }
  return { byNative, byLocal, byOriginal, definitions: [...byLocal.values()].map(entry => entry.definition) };
}

export function unwrapInput(value) {
  if (!isRecord(value) || !Object.hasOwn(value, 'input') || !isRecord(value.input)) {
    throw new WorkerError('invalid_tool_input');
  }
  return value.input;
}

/** Convert only native tool-result blocks with a lossless MCP equivalent. */
export function toMcpResult(content, isError = false) {
  let blocks;
  if (typeof content === 'string') blocks = [{ type: 'text', text: content }];
  else if (Array.isArray(content)) blocks = content.map(block => {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      if (Object.keys(block).some(key => key !== 'type' && key !== 'text')) throw new WorkerError('unsupported_tool_result');
      return { type: 'text', text: block.text };
    }
    if (isRecord(block) && block.type === 'image' && isRecord(block.source)
        && block.source.type === 'base64' && typeof block.source.data === 'string'
        && typeof block.source.media_type === 'string'
        && Object.keys(block).every(key => key === 'type' || key === 'source')
        && Object.keys(block.source).every(key => ['type', 'data', 'media_type'].includes(key))) {
      return { type: 'image', data: block.source.data, mimeType: block.source.media_type };
    }
    throw new WorkerError('unsupported_tool_result');
  });
  else throw new WorkerError('unsupported_tool_result');
  if (typeof isError !== 'boolean') throw new WorkerError('invalid_tool_result');
  return { content: blocks, isError };
}

/** Exact native IDs, including multiple concurrent identical tool names/arguments. */
export class ToolBroker {
  #calls = new Map();
  #closed = false;
  constructor(registry, emit, onFailure) {
    this.registry = registry;
    this.emit = emit;
    this.onFailure = onFailure;
  }
  reserve(id, entry, input) {
    if (this.#closed) throw new WorkerError('worker_closed');
    if (typeof id !== 'string' || !id || !entry || !isRecord(input)) throw new WorkerError('invalid_tool_input');
    const existing = this.#calls.get(id);
    if (existing) {
      if (existing.entry !== entry || !isDeepStrictEqual(existing.input, input)) throw new WorkerError('tool_id_mismatch');
      return existing;
    }
    const call = { entry, input: structuredClone(input), started: false, settled: false, result: undefined };
    this.#calls.set(id, call);
    return call;
  }
  preToolUse(input) {
    const entry = this.registry.byNative.get(input.tool_name);
    if (!entry) throw new WorkerError('unknown_tool');
    const args = unwrapInput(input.tool_input);
    this.reserve(input.tool_use_id, entry, args);
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: { input: args, [BROKER_ID]: input.tool_use_id },
      },
    };
  }
  async call(name, args, signal) {
    try {
      const entry = this.registry.byLocal.get(name);
      const id = isRecord(args) ? args[BROKER_ID] : undefined;
      const call = this.#calls.get(id);
      if (!entry || !call || call.entry !== entry || call.started || !isDeepStrictEqual(call.input, unwrapInput(args))) {
        throw new WorkerError('tool_id_mismatch');
      }
      if (this.#closed) throw new WorkerError('worker_closed');
      call.started = true;
      this.emit({ type: 'tool_pending', tool_use_id: id, name: entry.original });
      if (call.settled) return call.result;
      return await new Promise((resolve, reject) => {
        const abort = () => this.onFailure(new WorkerError('tool_cancelled'));
        call.resolve = result => { signal?.removeEventListener('abort', abort); resolve(result); };
        call.reject = error => { signal?.removeEventListener('abort', abort); reject(error); };
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      });
    } catch (error) {
      // Close the CLI BEFORE rejecting; a protocol error must not become a fabricated tool result.
      this.onFailure(error);
      throw error;
    }
  }
  deliver(message) {
    const call = this.#calls.get(message.tool_use_id);
    if (!call || call.settled || this.#closed) throw new WorkerError('unknown_tool_result');
    const result = toMcpResult(message.content, message.is_error ?? false);
    call.settled = true;
    call.result = result;
    call.resolve?.(result);
  }
  close() {
    this.#closed = true;
    for (const call of this.#calls.values()) call.reject?.(new WorkerError('worker_closed'));
    this.#calls.clear();
  }
}

/** Preserve all native events except the explicitly wrapped caller-tool arguments. */
export class NativeEventTransformer {
  #blocks = new Map();
  constructor(registry, broker) { this.registry = registry; this.broker = broker; }
  transform(event) {
    if (!isRecord(event) || typeof event.type !== 'string') throw new WorkerError('invalid_native_event');
    if (event.type === 'message_start') this.#blocks.clear();
    if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      const entry = this.registry.byNative.get(event.content_block.name);
      if (!entry) throw new WorkerError('unknown_tool');
      this.#blocks.set(event.index, { id: event.content_block.id, entry, initial: event.content_block.input, json: '' });
      return [{ ...event, content_block: { ...event.content_block, name: entry.original, input: {} } }];
    }
    const block = this.#blocks.get(event.index);
    if (block && event.type === 'content_block_delta') {
      if (event.delta?.type !== 'input_json_delta' || typeof event.delta.partial_json !== 'string') {
        throw new WorkerError('invalid_tool_input');
      }
      block.json += event.delta.partial_json;
      return [];
    }
    if (block && event.type === 'content_block_stop') {
      let wrapped;
      try { wrapped = block.json ? JSON.parse(block.json) : block.initial; }
      catch { throw new WorkerError('invalid_tool_input'); }
      const input = unwrapInput(wrapped);
      this.broker.reserve(block.id, block.entry, input);
      this.#blocks.delete(event.index);
      return [
        { type: 'content_block_delta', index: event.index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
        event,
      ];
    }
    return [event];
  }
}

export function nativeThinkingToSdk(thinking) {
  if (thinking === undefined) return undefined;
  if (!isRecord(thinking) || !['adaptive', 'enabled', 'disabled'].includes(thinking.type)) throw new WorkerError('unsupported_options');
  const allowed = thinking.type === 'enabled' ? ['type', 'budget_tokens', 'display'] : thinking.type === 'adaptive' ? ['type', 'display'] : ['type'];
  if (Object.keys(thinking).some(key => !allowed.includes(key))) throw new WorkerError('unsupported_options');
  if (thinking.display !== undefined && !['summarized', 'omitted', 'updates'].includes(thinking.display)) throw new WorkerError('unsupported_options');
  if (thinking.type === 'enabled' && (!Number.isSafeInteger(thinking.budget_tokens) || thinking.budget_tokens < 1024)) throw new WorkerError('unsupported_options');
  return {
    type: thinking.type,
    ...(thinking.budget_tokens === undefined ? {} : { budgetTokens: thinking.budget_tokens }),
    // The private forwarder supplies the explicit native updates option/beta;
    // use the documented SDK default rather than an unsupported SDK enum.
    ...(thinking.display === undefined || thinking.display === 'updates' ? {} : { display: thinking.display }),
  };
}

export function validateEffort(effort) {
  if (effort !== undefined && effort !== null && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new WorkerError('unsupported_options');
  return effort;
}

/** Explicit environment replacement: no competing auth/config/provider inherited. */
export function sdkEnvironment(start, inherited = process.env) {
  const env = {};
  for (const key of ['PATH', 'Path', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'USER', 'LOGNAME', 'LANG', 'LC_ALL']) {
    if (typeof inherited[key] === 'string') env[key] = inherited[key];
  }
  Object.assign(env, {
    CLAUDE_CONFIG_DIR: start.configDir,
    ANTHROPIC_BASE_URL: start.upstream,
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(start.maxTokens),
    CLAUDE_CODE_MAX_RETRIES: '0',
    CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES: '0',
    CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: '1',
    CLAUDE_CODE_NO_MODEL_FALLBACK: '1',
    CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK: '1',
    CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: '1',
    CLAUDE_CODE_DISABLE_REFUSAL_RETRY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '0',
    ENABLE_TOOL_SEARCH: 'false',
    // Broker owns a much shorter caller/session deadline and closes the query on expiry.
    MCP_TOOL_TIMEOUT: '2147483647',
    MAX_MCP_OUTPUT_TOKENS: '100000',
    CLAUDE_AGENT_SDK_CLIENT_APP: 'claude-code-proxy-cli-backend/1.0.0',
  });
  const authMode = start.authMode ?? 'configured';
  if (authMode === 'proxy') {
    if (!isRecord(start.credential) || typeof start.credential.token !== 'string' || !start.credential.token) throw new WorkerError('invalid_start');
    // This is an internal loopback relay nonce, never a provider OAuth token.
    env.ANTHROPIC_AUTH_TOKEN = start.credential.token;
  } else if (authMode === 'configured') {
    if (!isRecord(start.credential) || typeof start.credential.token !== 'string' || !start.credential.token
        || !['oauth', 'api_key'].includes(start.credential.kind)) throw new WorkerError('invalid_start');
    env[start.credential.kind === 'oauth' ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY'] = start.credential.token;
  } else if (authMode !== 'cli_store') throw new WorkerError('invalid_start');
  return env;
}

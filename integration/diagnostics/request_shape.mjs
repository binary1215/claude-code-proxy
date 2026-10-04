// Test-only passive request-shape projection. Never enable it as a content logger.
// No configurable keys/serializers: callers cannot widen the safe output vocabulary.
export const SHAPE_LIMITS = Object.freeze({ bodyBytes: 10 * 1024 * 1024, messages: 32,
  blocksPerArray: 32, totalBlocks: 256, tools: 64, systemBlocks: 16, contentDepth: 2,
  betaBytes: 4096, betaTokens: 64 });

const ENDPOINTS = new Set(['/v1/messages', '/v1/messages/count_tokens', '/v1/models']);
const HEADER_NAMES = new Set(['authorization', 'x-api-key', 'content-type', 'content-length',
  'accept', 'accept-encoding', 'anthropic-version', 'anthropic-beta', 'user-agent',
  'x-request-id', 'x-client-request-id', 'idempotency-key', 'x-stainless-lang',
  'x-stainless-package-version', 'x-stainless-os', 'x-stainless-arch', 'x-stainless-runtime',
  'x-stainless-runtime-version', 'x-stainless-retry-count', 'x-stainless-timeout']);
const BETAS = new Set(['oauth-2025-04-20', 'interleaved-thinking-2025-05-14',
  'prompt-caching-2024-07-31', 'extended-cache-ttl-2025-04-11',
  'fine-grained-tool-streaming-2025-05-14', 'context-1m-2025-08-07']);
const FIELDS = new Set(['model', 'max_tokens', 'messages', 'system', 'thinking', 'tools',
  'tool_choice', 'metadata', 'stream', 'stop_sequences', 'temperature', 'top_k', 'top_p',
  'cache_control', 'context_management', 'container', 'mcp_servers', 'output_config',
  'output_format', 'speed', 'inference_geo']);
const BLOCK_FIELDS = new Set(['type', 'text', 'thinking', 'signature', 'data', 'id', 'name',
  'input', 'tool_use_id', 'content', 'is_error', 'source', 'title', 'context', 'citations',
  'cache_control', 'server_name', 'is_error']);
const BLOCK_TYPES = new Set(['text', 'image', 'document', 'thinking', 'redacted_thinking',
  'tool_use', 'tool_result', 'server_tool_use', 'web_search_tool_result', 'web_fetch_tool_result',
  'code_execution_tool_result', 'bash_code_execution_tool_result',
  'text_editor_code_execution_tool_result', 'mcp_tool_use', 'mcp_tool_result', 'compaction']);
const TOOL_TYPES = new Set(['custom', 'web_search_20250305', 'web_search_20260209',
  'web_fetch_20250910', 'web_fetch_20260209', 'code_execution_20250522',
  'code_execution_20250825', 'code_execution_20260120', 'code_execution_20260209',
  'bash_20250124', 'text_editor_20250124', 'text_editor_20250429', 'text_editor_20250728']);
const MODEL_IDS = new Set(['claude-sonnet-4-6', 'claude-opus-4-6', 'claude-opus-4-7',
  'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1',
  'claude-sonnet-4-5', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5',
  'claude-haiku-4-5-20251001', 'claude-opus-4-5', 'claude-opus-4-5-20251101',
  'claude-sonnet-4-20250514', 'claude-opus-4-20250514', 'claude-opus-4-1-20250805']);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const has = (value, key) => object(value) && Object.hasOwn(value, key);
const bytes = (value) => typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : null;
const number = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1000000 ? value : null;
const unknownCount = (value, known) => object(value) ? Object.keys(value).filter((key) => !known.has(key)).length : null;
const presence = (value, known) => Object.fromEntries([...known].map((key) => [key, has(value, key)]));

function endpoint(url) {
  if (typeof url !== 'string' || url.length > 4096) return 'unknown';
  try {
    const path = new URL(url, 'http://shape.invalid').pathname.replace(/\/+$/, '');
    return ENDPOINTS.has(path) ? path : 'unknown';
  } catch { return 'unknown'; }
}
function betaShape(value, present) {
  const empty = { present, known: [], unknownCount: null, truncated: false };
  if (!present) return empty;
  if (typeof value !== 'string') return { ...empty, malformed: true };
  if (Buffer.byteLength(value) > SHAPE_LIMITS.betaBytes) return { ...empty, truncated: true };
  const tokens = value.split(',');
  const known = new Set();
  let unknown = 0;
  for (const token of tokens.slice(0, SHAPE_LIMITS.betaTokens)) {
    const normalized = token.trim();
    if (BETAS.has(normalized)) known.add(normalized);
    else unknown++;
  }
  return { present, known: [...known].sort(), unknownCount: unknown,
    truncated: tokens.length > SHAPE_LIMITS.betaTokens };
}
function headerShape(headers) {
  const known = Object.fromEntries([...HEADER_NAMES].map((name) => [name, false]));
  let unknown = 0;
  let beta;
  if (object(headers)) for (const name of Object.keys(headers)) {
    const normalized = name.toLowerCase();
    if (HEADER_NAMES.has(normalized)) {
      known[normalized] = true;
      // This one header has a closed public enum projection; all other values stay unread.
      if (normalized === 'anthropic-beta') beta = headers[name];
    } else unknown++;
  }
  const authorization = known.authorization;
  const apiKey = known['x-api-key'];
  return { presence: known, unknownFieldCount: unknown,
    authKind: authorization && apiKey ? 'both' : authorization ? 'bearer' : apiKey ? 'api_key' : 'none',
    beta: betaShape(beta, known['anthropic-beta']) };
}
function modelShape(value) {
  if (value == null) return { family: null, knownId: null };
  if (typeof value !== 'string') return { family: 'unknown', knownId: null };
  const match = /^claude-(haiku|sonnet|opus|fable)-[0-9][a-z0-9-]{0,63}$/.exec(value);
  // A pattern match never authorizes logging its arbitrary suffix/version text.
  return { family: match ? match[1] : 'unknown', knownId: MODEL_IDS.has(value) ? value : null };
}
function cacheShape(value, context) {
  if (!has(value, 'cache_control')) return null;
  const marker = value.cache_control;
  const type = object(marker) && marker.type === 'ephemeral' ? 'ephemeral' : 'unknown';
  const ttl = object(marker) && !has(marker, 'ttl') ? 'default' :
    marker?.ttl === '5m' ? '5m' : marker?.ttl === '1h' ? '1h' : 'unknown';
  context.cache.observedCount++;
  context.cache.types[type]++;
  context.cache.ttls[ttl]++;
  return { type, ttl };
}
function truncated(context) { context.truncated = true; context.cache.truncated = true; }
function block(value, context, depth) {
  if (context.remainingBlocks <= 0) { truncated(context); return null; }
  context.remainingBlocks--;
  if (typeof value === 'string') return { type: 'text', textBytes: bytes(value), stringForm: true };
  if (!object(value)) return { type: 'unknown', malformed: true };
  const type = BLOCK_TYPES.has(value.type) ? value.type : 'unknown';
  const summary = { type, unknownFieldCount: unknownCount(value, BLOCK_FIELDS),
    textBytes: type === 'text' ? bytes(value.text) : type === 'thinking' ? bytes(value.thinking) : null,
    signaturePresent: has(value, 'signature'), opaqueDataPresent: has(value, 'data'),
    cacheControl: cacheShape(value, context) };
  if (type === 'tool_result' || type === 'mcp_tool_result') {
    summary.isError = typeof value.is_error === 'boolean' ? value.is_error : null;
    summary.content = content(value.content, context, depth + 1);
  }
  return summary;
}
function content(value, context, depth = 0, limit = SHAPE_LIMITS.blocksPerArray) {
  if (typeof value === 'string') return { kind: 'text', textBytes: bytes(value) };
  if (!Array.isArray(value)) return { kind: value == null ? 'absent' : 'unknown' };
  const result = { kind: 'blocks', count: value.length, sampled: [], truncated: false };
  if (depth > SHAPE_LIMITS.contentDepth) { result.truncated = true; truncated(context); return result; }
  for (const item of value.slice(0, limit)) {
    const summary = block(item, context, depth);
    if (summary === null) { result.truncated = true; break; }
    result.sampled.push(summary);
  }
  if (result.sampled.length < value.length) { result.truncated = true; truncated(context); }
  return result;
}
function messagesShape(value, context) {
  if (!Array.isArray(value)) return { count: null, sampled: [], malformed: value != null, truncated: false };
  const sampled = value.slice(0, SHAPE_LIMITS.messages).map((message) => ({
    role: ['user', 'assistant', 'system', 'tool'].includes(message?.role) ? message.role : 'unknown',
    unknownFieldCount: unknownCount(message, new Set(['role', 'content'])),
    content: content(object(message) ? message.content : undefined, context),
  }));
  const isTruncated = value.length > sampled.length;
  if (isTruncated) truncated(context);
  return { count: value.length, sampled, truncated: isTruncated };
}
function toolsShape(value, context) {
  if (!Array.isArray(value)) return { count: null, sampled: [], malformed: value != null, truncated: false };
  const sampled = value.slice(0, SHAPE_LIMITS.tools).map((tool) => ({
    type: object(tool) && !has(tool, 'type') ? 'custom' : TOOL_TYPES.has(tool?.type) ? tool.type : 'unknown',
    inputSchemaPresent: has(tool, 'input_schema'), cacheControl: cacheShape(tool, context),
  }));
  const isTruncated = value.length > sampled.length;
  if (isTruncated) truncated(context);
  return { count: value.length, sampled, truncated: isTruncated };
}

/** Input bytes are never changed; output contains only fixed enums, counts and presence bits. */
export function summarizeRequest({ method, url, headers, body } = {}) {
  const result = { method: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'].includes(method) ? method : 'unknown',
    endpoint: endpoint(url), headers: headerShape(headers),
    body: { bytes: Buffer.isBuffer(body) ? body.length : null, state: 'unsupported_type' } };
  if (!Buffer.isBuffer(body)) return result;
  if (!body.length) { result.body.state = 'empty'; return result; }
  if (body.length > SHAPE_LIMITS.bodyBytes) { result.body.state = 'too_large'; return result; }
  let parsed;
  try { parsed = JSON.parse(body.toString('utf8')); } catch { result.body.state = 'invalid_json'; return result; }
  if (!object(parsed)) { result.body.state = 'invalid_shape'; return result; }
  const context = { remainingBlocks: SHAPE_LIMITS.totalBlocks, truncated: false,
    cache: { observedCount: 0, types: { ephemeral: 0, unknown: 0 },
      ttls: { default: 0, '5m': 0, '1h': 0, unknown: 0 }, truncated: false } };
  const metadataKeys = new Set(['user_id']);
  result.body = { bytes: body.length, state: 'parsed', knownPresence: presence(parsed, FIELDS),
    unknownFieldCount: unknownCount(parsed, FIELDS), model: modelShape(parsed.model),
    maxTokens: number(parsed.max_tokens), stream: typeof parsed.stream === 'boolean' ? parsed.stream : null,
    thinking: { present: has(parsed, 'thinking'),
      type: ['enabled', 'disabled', 'adaptive'].includes(parsed.thinking?.type) ? parsed.thinking.type :
        has(parsed, 'thinking') ? 'unknown' : null,
      budgetTokens: number(parsed.thinking?.budget_tokens) },
    cacheControl: cacheShape(parsed, context), system: content(parsed.system, context, 0, SHAPE_LIMITS.systemBlocks),
    messages: messagesShape(parsed.messages, context), tools: toolsShape(parsed.tools, context),
    metadata: { present: has(parsed, 'metadata'), malformed: has(parsed, 'metadata') && !object(parsed.metadata),
      knownPresence: presence(parsed.metadata, metadataKeys), unknownFieldCount: unknownCount(parsed.metadata, metadataKeys) },
    cacheMarkers: context.cache, truncated: context.truncated };
  return result;
}

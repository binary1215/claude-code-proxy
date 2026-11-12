import { randomUUID } from 'node:crypto';
import { WorkerError, isRecord, nativeToolName } from './helpers.mjs';

// This is deliberately pinned to the CLI bundled with Agent SDK 0.3.322.
// SessionStore is public; the JSONL entry body it transports is CLI-internal.
export const HISTORY_CLI_VERSION = '2.1.322';

/**
 * Materialize a caller-composed compacted history without flattening roles or
 * replacing signed thinking. Completed calls must be loaded WITH their results:
 * resuming a dangling call makes the CLI synthesize an interrupted-tool result.
 */
export function nativeHistoryEntries(history, { model, cwd, systemCarriers = [], compactOnly = false, sessionId = randomUUID(), timestamp = new Date().toISOString() }) {
  if (!Array.isArray(history) || !history.length || typeof model !== 'string' || !model || typeof cwd !== 'string' || !cwd) {
    throw new WorkerError('invalid_history');
  }
  if (!Array.isArray(systemCarriers)) throw new WorkerError('invalid_history');
  const carriers = new Map();
  const markers = new Set();
  for (const carrier of systemCarriers) {
    if (!isRecord(carrier) || !Number.isSafeInteger(carrier.index) || carrier.index < 0 || carrier.index >= history.length
        || history[carrier.index]?.role !== 'system' || typeof carrier.marker !== 'string' || !carrier.marker
        || carrier.marker.includes('\n') || carriers.has(carrier.index) || markers.has(carrier.marker)) throw new WorkerError('invalid_history');
    carriers.set(carrier.index, carrier.marker);
    markers.add(carrier.marker);
  }
  const pending = new Set();
  let previous = null;
  const entries = history.map((source, index) => {
    if (!isRecord(source) || !['user', 'assistant', 'system'].includes(source.role)) throw new WorkerError('invalid_history');
    const content = typeof source.content === 'string' ? [{ type: 'text', text: source.content }] : structuredClone(source.content);
    if (!Array.isArray(content) || content.some(block => !isRecord(block) || typeof block.type !== 'string')) throw new WorkerError('invalid_history');
    if (source.role === 'system' && (!carriers.has(index) || content.some(block => block.type !== 'text' || typeof block.text !== 'string'))) throw new WorkerError('invalid_history');
    const mapped = content.map(block => {
      if (block.type === 'tool_use') {
        if (source.role !== 'assistant' || typeof block.id !== 'string' || !block.id || pending.has(block.id)
            || typeof block.name !== 'string' || !block.name || !isRecord(block.input)) throw new WorkerError('invalid_history');
        pending.add(block.id);
        return { ...block, name: nativeToolName(block.name), input: { input: block.input } };
      }
      if (block.type === 'tool_result') {
        if (source.role !== 'user' || !pending.delete(block.tool_use_id)) throw new WorkerError('invalid_history');
      }
      return block;
    });
    const uuid = randomUUID();
    const message = source.role === 'assistant' ? {
      id: `msg_proxy_import_${uuid.replaceAll('-', '')}`,
      type: 'message', model, role: 'assistant', content: mapped,
      stop_reason: mapped.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      // Historical counters are unknown: omit usage rather than fabricate zeros.
    } : { role: 'user', content: mapped };
    const entry = {
      type: source.role, uuid, parentUuid: previous, sessionId, timestamp,
      cwd, version: HISTORY_CLI_VERSION, isSidechain: false, userType: 'external',
      requestedModel: model, message,
    };
    if (source.role === 'system') {
      // api_system transcript rows are discarded on resume in this pinned CLI.
      // Its persisted rendered attachment retains role/order. The trusted
      // private forwarder restores the complete caller record from this marker;
      // cache controls, effort and caller-relative lifetime are never inferred
      // from the carrier. Include source text for genuine CLI token estimates.
      entry.type = 'attachment';
      delete entry.message;
      entry.attachment = { type: 'caller_system' };
      entry.rendered = [{ content: `${carriers.get(index)}\n${content.map(block => block.text).join('\n\n')}` }];
      entry.renderedRole = 'system';
    }
    previous = uuid;
    return entry;
  });
  if (pending.size || (!compactOnly && !['user', 'system'].includes(history.at(-1).role))) throw new WorkerError('invalid_history');
  return { sessionId, entries };
}

/** Request-local adapter. Compaction can capture its live transcript in memory;
 * ordinary inference remains import-only. Neither mode adds remote persistence. */
export function nativeHistoryStore(snapshot, { capture = false } = {}) {
  const entries = structuredClone(snapshot.entries);
  return {
    append: async (key, batch) => {
      if (!capture || key.sessionId !== snapshot.sessionId || key.subpath) return;
      for (const source of batch) {
        const entry = structuredClone(source);
        const index = entry.uuid ? entries.findIndex(value => value.uuid === entry.uuid) : -1;
        if (index < 0) entries.push(entry); else entries[index] = entry;
      }
    },
    load: async key => key.sessionId === snapshot.sessionId && !key.subpath ? structuredClone(entries) : null,
    listSubkeys: async () => [],
  };
}

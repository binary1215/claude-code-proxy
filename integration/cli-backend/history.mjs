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
export function nativeHistoryEntries(history, { model, cwd, sessionId = randomUUID(), timestamp = new Date().toISOString() }) {
  if (!Array.isArray(history) || !history.length || typeof model !== 'string' || !model || typeof cwd !== 'string' || !cwd) {
    throw new WorkerError('invalid_history');
  }
  const pending = new Set();
  let previous = null;
  const entries = history.map(source => {
    if (!isRecord(source) || !['user', 'assistant'].includes(source.role)) throw new WorkerError('invalid_history');
    const content = typeof source.content === 'string' ? [{ type: 'text', text: source.content }] : structuredClone(source.content);
    if (!Array.isArray(content) || content.some(block => !isRecord(block) || typeof block.type !== 'string')) throw new WorkerError('invalid_history');
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
    previous = uuid;
    return entry;
  });
  if (pending.size || entries.at(-1).type !== 'user') throw new WorkerError('invalid_history');
  return { sessionId, entries };
}

/** An import-only adapter; no remote persistence, logs or retained mirror. */
export function nativeHistoryStore(snapshot) {
  return {
    append: async () => {},
    load: async key => key.sessionId === snapshot.sessionId ? structuredClone(snapshot.entries) : null,
    listSubkeys: async () => [],
  };
}

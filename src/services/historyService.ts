import { db } from "../db/connection.js";
import type { RequestLog, HistoryQuery, HistoryStats } from "../types/index.js";

export function insertPendingRequest(params: {
  apiKeyId: number | null;
  completionId: string;
  requestedModel: string;
  resolvedModel: string;
  isStream: boolean;
  promptPreview?: string | null;
  fullPrompt?: string | null;
}): number {
  const result = db.prepare(`
    INSERT INTO request_log (api_key_id, completion_id, requested_model, resolved_model, is_stream, prompt_preview, full_prompt, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(
    params.apiKeyId,
    params.completionId,
    params.requestedModel,
    params.resolvedModel,
    params.isStream ? 1 : 0,
    null,
    null
  );
  return result.lastInsertRowid as number;
}

export function completeRequest(
  logId: number,
  status: "success" | "error" | "cancelled",
  data: {
    inputTokens?: number | null;
    outputTokens?: number | null;
    totalCostUsd?: number | null;
    cacheCreationInputTokens?: number | null;
    cacheReadInputTokens?: number | null;
    cacheCreation5mTokens?: number | null;
    cacheCreation1hTokens?: number | null;
    usageComplete?: boolean;
    durationMs?: number;
    errorMessage?: string;
    fullResponse?: string;
  }
): void {
  db.prepare(`
    UPDATE request_log
    SET status = ?,
        input_tokens = ?,
        output_tokens = ?,
        total_cost_usd = ?,
        cache_creation_input_tokens = ?,
        cache_read_input_tokens = ?,
        cache_creation_5m_tokens = ?,
        cache_creation_1h_tokens = ?,
        usage_complete = ?,
        duration_ms = ?,
        error_message = ?,
        full_response = ?,
        completed_at = datetime('now')
    WHERE id = ? AND status = 'pending'
  `).run(
    status,
    data.inputTokens ?? null,
    data.outputTokens ?? null,
    data.totalCostUsd ?? null,
    data.cacheCreationInputTokens ?? null,
    data.cacheReadInputTokens ?? null,
    data.cacheCreation5mTokens ?? null,
    data.cacheCreation1hTokens ?? null,
    data.usageComplete ? 1 : 0,
    data.durationMs ?? 0,
    status === "error" ? safeErrorType(data.errorMessage) : null,
    null,
    logId
  );
}

// Keep only known operational categories, never upstream text or caller data.
const ERROR_TYPES = new Set([
  "rate_limit_error", "not_found_error", "authentication_error",
  "permission_error", "billing_error", "server_error", "upstream_error", "invalid_request_error",
]);

function safeErrorType(value?: string): string {
  return value && ERROR_TYPES.has(value) ? value : "upstream_error";
}

export function getRequestDetail(id: number): (RequestLog & { full_prompt: string | null; full_response: string | null }) | null {
  const row = db.prepare(
    "SELECT r.*, k.name as api_key_name FROM request_log r LEFT JOIN api_keys k ON r.api_key_id = k.id WHERE r.id = ?"
  ).get(id) as (RequestLog & { full_prompt: string | null; full_response: string | null }) | undefined;
  return row ?? null;
}

export function queryHistory(params: HistoryQuery): { rows: RequestLog[]; total: number } {
  const conditions: string[] = [];
  const values: any[] = [];

  if (params.api_key_id) {
    conditions.push("r.api_key_id = ?");
    values.push(params.api_key_id);
  }
  if (params.model) {
    conditions.push("r.resolved_model = ?");
    values.push(params.model);
  }
  if (params.status) {
    conditions.push("r.status = ?");
    values.push(params.status);
  }
  if (params.from) {
    conditions.push("r.created_at >= ?");
    values.push(params.from);
  }
  if (params.to) {
    conditions.push("r.created_at <= ?");
    values.push(params.to);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;

  const countRow = db.prepare(
    `SELECT COUNT(*) as total FROM request_log r ${where}`
  ).get(...values) as { total: number };

  const rows = db.prepare(
    `SELECT r.*, k.name as api_key_name FROM request_log r LEFT JOIN api_keys k ON r.api_key_id = k.id ${where} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`
  ).all(...values, limit, offset) as RequestLog[];

  return { rows, total: countRow.total };
}

export function getStats(from?: string, to?: string): HistoryStats {
  const conditions: string[] = [];
  const values: any[] = [];

  if (from) {
    conditions.push("created_at >= ?");
    values.push(from);
  }
  if (to) {
    conditions.push("created_at <= ?");
    values.push(to);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const totals = db.prepare(`
    SELECT
      COUNT(*) as total_requests,
      CASE WHEN COUNT(total_cost_usd) = COUNT(*) THEN SUM(total_cost_usd) END as total_cost_usd,
      CASE WHEN COUNT(input_tokens) = COUNT(*) THEN SUM(input_tokens) END as total_input_tokens,
      CASE WHEN COUNT(output_tokens) = COUNT(*) THEN SUM(output_tokens) END as total_output_tokens
    FROM request_log ${where}
  `).get(...values) as {
    total_requests: number;
    total_cost_usd: number | null;
    total_input_tokens: number | null;
    total_output_tokens: number | null;
  };

  const byModel = db.prepare(`
    SELECT resolved_model as model, COUNT(*) as count,
      CASE WHEN COUNT(total_cost_usd) = COUNT(*) THEN SUM(total_cost_usd) END as cost_usd
    FROM request_log ${where}
    GROUP BY resolved_model ORDER BY count DESC
  `).all(...values) as Array<{ model: string; count: number; cost_usd: number | null }>;

  const byStatus = db.prepare(`
    SELECT status, COUNT(*) as count
    FROM request_log ${where}
    GROUP BY status ORDER BY count DESC
  `).all(...values) as Array<{ status: string; count: number }>;

  return { ...totals, by_model: byModel, by_status: byStatus };
}

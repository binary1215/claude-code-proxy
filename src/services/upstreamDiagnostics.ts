import type { IncomingHttpHeaders } from "node:http";
import { StringDecoder } from "node:string_decoder";

export type DiagnosticReason = "success" | "provider_error" | "unknown_429" | "http_error" |
  "network_error" | "timeout" | "cancelled" | "truncated_stream";
export type BodyObservation = "not_received" | "observed" | "empty" | "invalid_json" |
  "compressed" | "unsupported_content_type" | "too_large" | "incomplete";
export interface UpstreamDiagnostics {
  upstream_http_status: number | null;
  upstream_error_type: string | null;
  upstream_error_code: string | null;
  upstream_request_id: string | null;
  upstream_retry_after: string | null;
  upstream_quota_headers: string | null;
  upstream_auth_kind: "oauth" | "api_key" | null;
  upstream_diagnostic: DiagnosticReason | null;
  upstream_body_observation: BodyObservation | null;
}

// Never retain open-ended provider strings (especially error.message).
const ERROR_TYPES = new Set(["invalid_request_error", "authentication_error", "permission_error",
  "not_found_error", "request_too_large", "rate_limit_error", "api_error", "overloaded_error",
  "billing_error", "server_error"]);
const ERROR_CODES = new Set(["claude_code_version_too_old", "rate_limit_exceeded", "quota_exceeded",
  "usage_limit_exceeded", "insufficient_quota", "invalid_api_key", "permission_denied",
  "billing_hard_limit_reached", "token_limit_exceeded", "overloaded"]);
const REASONS = new Set<DiagnosticReason>(["success", "provider_error", "unknown_429", "http_error",
  "network_error", "timeout", "cancelled", "truncated_stream"]);
const OBSERVATIONS = new Set<BodyObservation>(["not_received", "observed", "empty", "invalid_json",
  "compressed", "unsupported_content_type", "too_large", "incomplete"]);
const STATUSES = new Set(["allowed", "allowed_warning", "rejected"]);
const QUOTA_FIELDS = new Map<string, "status" | "reset" | "utilization">();
for (const window of ["", "5h-", "7d-", "overage-"]) {
  for (const field of ["status", "reset", "utilization"] as const) {
    QUOTA_FIELDS.set(`anthropic-ratelimit-unified-${window}${field}`, field);
  }
}
const member = (set: Set<string>, value: unknown): string | null =>
  typeof value === "string" && set.has(value) ? value : null;
const singleHeader = (value: unknown): string | null => typeof value === "string" ? value : null;
const requestId = (value: unknown): string | null => typeof value === "string" &&
  (/^req_01[A-Za-z0-9]{20,64}$/.test(value) ||
   /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) ? value : null;

function retryAfter(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (/^(?:0|[1-9]\d{0,7})$/.test(value) && Number(value) <= 31536000) return value;
  if (!/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) return null;
  const date = new Date(value);
  return date.getUTCFullYear() >= 1970 && date.getUTCFullYear() <= 2100 && date.toUTCString() === value ? value : null;
}
function quotaValue(kind: "status" | "reset" | "utilization", value: unknown): string | number | null {
  if (kind === "status") return member(STATUSES, value);
  if (typeof value === "number") value = String(value);
  if (typeof value !== "string") return null;
  if (kind === "utilization") {
    return /^(?:0|[1-9]\d{0,2})(?:\.\d{1,6})?$/.test(value) && Number(value) <= 100 ? Number(value) : null;
  }
  if (/^(?:0|[1-9]\d{0,9})$/.test(value) && Number(value) <= 4102444800) return Number(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return null;
  const date = new Date(value);
  const normalized = value.includes(".") ? value : value.replace("Z", ".000Z");
  return Number.isFinite(date.valueOf()) && date.getUTCFullYear() >= 1970 && date.getUTCFullYear() <= 2100 &&
    date.toISOString() === normalized ? date.toISOString() : null;
}
function safeQuotaMap(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result: Record<string, string | number> = {};
  for (const [name, kind] of QUOTA_FIELDS) {
    const safe = quotaValue(kind, (value as Record<string, unknown>)[name]);
    if (safe !== null) result[name] = safe;
  }
  return Object.keys(result).length ? JSON.stringify(result) : null;
}

/** Storage boundary: repeat validation even for other/legacy history writers. */
export function sanitizeDiagnostics(value: Partial<UpstreamDiagnostics> = {}): UpstreamDiagnostics {
  if (!value || typeof value !== "object" || Array.isArray(value)) value = {};
  let quota: unknown;
  if (typeof value.upstream_quota_headers === "string" && value.upstream_quota_headers.length <= 4096) {
    try { quota = JSON.parse(value.upstream_quota_headers); } catch { /* Unknown, never store raw. */ }
  }
  return {
    upstream_http_status: Number.isInteger(value.upstream_http_status) && Number(value.upstream_http_status) >= 100 &&
      Number(value.upstream_http_status) <= 599 ? value.upstream_http_status! : null,
    upstream_error_type: member(ERROR_TYPES, value.upstream_error_type),
    upstream_error_code: member(ERROR_CODES, value.upstream_error_code),
    upstream_request_id: requestId(value.upstream_request_id),
    upstream_retry_after: retryAfter(value.upstream_retry_after),
    upstream_quota_headers: safeQuotaMap(quota),
    upstream_auth_kind: value.upstream_auth_kind === "oauth" || value.upstream_auth_kind === "api_key" ? value.upstream_auth_kind : null,
    upstream_diagnostic: member(REASONS, value.upstream_diagnostic) as DiagnosticReason | null,
    upstream_body_observation: member(OBSERVATIONS, value.upstream_body_observation) as BodyObservation | null,
  };
}

/** Bounded passive observer: cannot modify transport, retry, or authorize fallback. */
export class UpstreamDiagnosticsObserver {
  private decoder = new StringDecoder("utf8");
  private pending = "";
  private data: string[] = [];
  private eventBytes = 0;
  private sse = false;
  private observable = false;
  private terminal = false;
  private sawError = false;
  private fields: UpstreamDiagnostics;
  private static readonly LIMIT = 64 * 1024;

  constructor(authKind: "oauth" | "api_key") {
    this.fields = { ...sanitizeDiagnostics(), upstream_auth_kind: authKind, upstream_body_observation: "not_received" };
  }
  receive(status: number, headers: IncomingHttpHeaders): void {
    this.fields.upstream_http_status = status;
    this.fields.upstream_request_id = requestId(singleHeader(headers["request-id"])) ??
      requestId(singleHeader(headers["x-request-id"]));
    this.fields.upstream_retry_after = retryAfter(singleHeader(headers["retry-after"]));
    this.fields.upstream_quota_headers = safeQuotaMap(headers);
    const type = String(headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    this.sse = type === "text/event-stream";
    const encoding = singleHeader(headers["content-encoding"]);
    if (headers["content-encoding"] !== undefined && encoding !== "identity") this.stop("compressed");
    else if (this.sse || type === "application/json" || type === "application/problem+json") {
      this.observable = true;
      this.fields.upstream_body_observation = "incomplete";
    } else this.stop("unsupported_content_type");
  }
  write(chunk: Buffer): void {
    if (!this.observable) return;
    this.pending += this.decoder.write(chunk);
    if (!this.sse) {
      if (Buffer.byteLength(this.pending) > UpstreamDiagnosticsObserver.LIMIT) this.stop("too_large");
      return;
    }
    let end: number;
    while ((end = this.pending.search(/[\r\n]/)) !== -1) {
      if (this.pending[end] === "\r" && end === this.pending.length - 1) break;
      const line = this.pending.slice(0, end);
      const width = this.pending[end] === "\r" && this.pending[end + 1] === "\n" ? 2 : 1;
      this.pending = this.pending.slice(end + width);
      this.line(line);
      if (!this.observable) return;
    }
    if (Buffer.byteLength(this.pending) > UpstreamDiagnosticsObserver.LIMIT) this.stop("too_large");
  }
  end(): void {
    if (!this.observable) return;
    this.pending += this.decoder.end();
    if (!this.sse) {
      if (!this.pending.length) this.fields.upstream_body_observation = "empty";
      else this.fields.upstream_body_observation = this.observeJson(this.pending) ? "observed" : "invalid_json";
    } else {
      if (this.pending === "\r") this.line("");
      this.fields.upstream_body_observation = this.terminal ? "observed" : "incomplete";
    }
    this.pending = ""; this.data = [];
  }
  snapshot(reason?: DiagnosticReason): UpstreamDiagnostics {
    const status = this.fields.upstream_http_status;
    // 429 itself (or a rate_limit_error type) proves neither entitlement nor quota cause.
    const inferred = status === 429 && !this.fields.upstream_error_code ? "unknown_429" :
      this.sawError || this.fields.upstream_error_type || this.fields.upstream_error_code ? "provider_error" :
      status !== null && status >= 200 && status < 300 ? "success" :
      status !== null ? "http_error" : "network_error";
    // A generic error-event fact cannot explain the cause of a 429 either.
    const finalReason = reason === "provider_error" && status === 429 && !this.fields.upstream_error_code ?
      "unknown_429" : reason ?? inferred;
    return sanitizeDiagnostics({ ...this.fields, upstream_diagnostic: finalReason });
  }
  private stop(state: BodyObservation): void {
    this.observable = false; this.pending = ""; this.data = [];
    this.fields.upstream_body_observation = state;
  }
  private line(line: string): void {
    if (line === "") {
      if (this.data.length) this.observeJson(this.data.join("\n"));
      this.data = []; this.eventBytes = 0;
    } else if (line.startsWith("data:")) {
      const value = line.slice(5).replace(/^ /, "");
      // Count framing too: endless empty data lines must not grow the array unbounded.
      this.eventBytes += Buffer.byteLength(value) + 1;
      if (this.eventBytes > UpstreamDiagnosticsObserver.LIMIT) this.stop("too_large");
      else this.data.push(value);
    }
  }
  private observeJson(text: string): boolean {
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { return false; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    if (parsed.type === "message_stop" || parsed.type === "error") this.terminal = true;
    if (parsed.type === "error") this.sawError = true;
    const error = parsed.error;
    if (error && typeof error === "object" && !Array.isArray(error)) {
      this.fields.upstream_error_type = member(ERROR_TYPES, error.type) ?? this.fields.upstream_error_type;
      this.fields.upstream_error_code = member(ERROR_CODES, error.code) ??
        member(ERROR_CODES, error.details?.error_code) ?? this.fields.upstream_error_code;
    }
    return true;
  }
}

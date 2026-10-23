import type { TokenAggregate } from "./api";

export function formatTokenCount(value: number | null | undefined): string {
  return value == null ? "Unknown" : value.toLocaleString();
}

export function formatCost(value: number | null | undefined): string {
  return value == null ? "Unknown" : `$${value.toFixed(4)}`;
}

export function formatTotalTokens(input: number | null, output: number | null): string {
  return input == null || output == null ? "Unknown" : (input + output).toLocaleString();
}

/** Native input excludes cache reads/writes; never turn unreported counters into zero. */
export function formatTotalInputTokens(fresh: number | null | undefined, written: number | null | undefined, read: number | null | undefined): string {
  const values = [fresh, written, read];
  if (values.some(value => value == null || !Number.isSafeInteger(value) || value < 0)) return "Unknown";
  const total = fresh! + written! + read!;
  return Number.isSafeInteger(total) ? total.toLocaleString() : "Unknown";
}

export const USAGE_ACCOUNTING_NOTICE =
  "Fresh input excludes cache reads and writes. Total input = fresh + cache write + cache read; 5m/1h writes are subsets of cache write and are not added again. Complete means terminal input/output usage was observed, not that every cache counter or charge is known. Unknown is not zero or free. LiteLLM custom-route totals may not include these provider counters; this history is not a billing statement.";
export function formatAggregateTokens(metric: TokenAggregate): { value: string; detail: string | null } {
  if (metric.total_tokens != null) return { value: formatTokenCount(metric.total_tokens), detail: null };
  const requests = metric.reported_requests + metric.unknown_requests;
  const coverage = `${metric.reported_requests}/${requests} requests reported`;
  return {
    value: "Unknown",
    detail: metric.known_tokens == null
      ? coverage
      : `Known subtotal: ${formatTokenCount(metric.known_tokens)} (${coverage}; may include non-final usage)`,
  };
}

export const USAGE_AGGREGATION_NOTICE =
  "Period totals are complete only when every request reports terminal usage and the selected counter. Known subtotals contain observed values only, may include non-final usage, and are not complete totals. Coverage below requires terminal usage plus fresh input, cache write, cache read and output; partial means at least one counter was observed, and unknown means none were observed. TTL-specific writes are not added again. Token totals are not prices or a billing statement; this does not repair LiteLLM accounting.";

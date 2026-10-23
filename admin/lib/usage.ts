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

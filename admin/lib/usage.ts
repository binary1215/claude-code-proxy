export function formatTokenCount(value: number | null | undefined): string {
  return value == null ? "Unknown" : value.toLocaleString();
}

export function formatCost(value: number | null | undefined): string {
  return value == null ? "Unknown" : `$${value.toFixed(4)}`;
}

export function formatTotalTokens(input: number | null, output: number | null): string {
  return input == null || output == null ? "Unknown" : (input + output).toLocaleString();
}

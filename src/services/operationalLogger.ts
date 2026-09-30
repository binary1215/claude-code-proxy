import { classifyUpstreamError } from "./errorClassifier.js";

// Do not serialize Error objects: upstreamText/stderr may contain conversations
// or credentials. Use fixed call-site event names and classified metadata only.
export function logOperationalError(event: string, err: unknown): void {
  const { status, type } = classifyUpstreamError(err);
  console.error(JSON.stringify({ event, status, type }));
}

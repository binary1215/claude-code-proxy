// Never serialize errors, upstream bodies, headers or conversation content.
export function logOperationalError(event: string, _err: unknown): void {
  console.error(JSON.stringify({ event, type: "upstream_error" }));
}

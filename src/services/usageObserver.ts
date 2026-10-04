import { StringDecoder } from "node:string_decoder";

export interface ObservedUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreation5mTokens: number | null;
  cacheCreation1hTokens: number | null;
  usageComplete: boolean;
}

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** A bounded, non-authoritative observer. It never writes to the transport. */
export class UsageObserver {
  private decoder = new StringDecoder("utf8");
  private pending = "";
  private data: string[] = [];
  private eventBytes = 0;
  private disabled = false;
  private stopped = false;
  hasError = false;
  private usage: ObservedUsage = {
    inputTokens: null, outputTokens: null, cacheCreationInputTokens: null,
    cacheReadInputTokens: null, cacheCreation5mTokens: null, cacheCreation1hTokens: null,
    usageComplete: false,
  };

  constructor(private readonly sse: boolean, private readonly observable = true) {}

  write(chunk: Buffer): void {
    if (this.disabled || !this.observable) return;
    this.pending += this.decoder.write(chunk);
    if (!this.sse) {
      if (this.pending.length > 4 * 1024 * 1024) this.disable();
      return;
    }
    // Normalize CR, LF and CRLF across chunk boundaries without touching raw bytes.
    let end: number;
    while ((end = this.pending.search(/[\r\n]/)) !== -1) {
      if (this.pending[end] === "\r" && end === this.pending.length - 1) break;
      const line = this.pending.slice(0, end);
      const width = this.pending[end] === "\r" && this.pending[end + 1] === "\n" ? 2 : 1;
      this.pending = this.pending.slice(end + width);
      this.line(line);
      if (this.disabled) return;
    }
    if (this.pending.length > 1024 * 1024) this.disable();
  }

  end(): void {
    if (this.disabled || !this.observable) return;
    this.pending += this.decoder.end();
    if (!this.sse) {
      const parsed = this.parse(this.pending);
      if (parsed?.type === "message") {
        this.observe(parsed.usage);
        this.stopped = true;
      }
    } else if (this.pending.endsWith("\r")) {
      // A final CR is itself a valid SSE line terminator (no LF lookahead at EOF).
      this.line(this.pending.slice(0, -1));
    }
    // An unterminated SSE event is not a confirmed terminal event.
    this.pending = "";
    this.data = [];
  }

  snapshot(): ObservedUsage {
    return { ...this.usage, usageComplete: !this.disabled && !this.hasError && this.stopped &&
      this.usage.inputTokens !== null && this.usage.outputTokens !== null };
  }

  get streamComplete(): boolean { return this.stopped && !this.hasError; }
  get canObserve(): boolean { return this.observable && !this.disabled; }

  private disable(): void { this.disabled = true; this.pending = ""; this.data = []; }
  private parse(text: string): Record<string, any> | null {
    try {
      const value = JSON.parse(text);
      return value && typeof value === "object" && !Array.isArray(value) ? value : null;
    } catch { return null; }
  }
  private line(line: string): void {
    if (line === "") {
      if (this.data.length) {
        const event = this.parse(this.data.join("\n"));
        if (event?.type === "message_start") this.observe(event.message?.usage);
        if (event?.type === "message_delta") this.observe(event.usage);
        if (event?.type === "message_stop") this.stopped = true;
        if (event?.type === "error") this.hasError = true;
      }
      this.data = []; this.eventBytes = 0;
    } else if (line.startsWith("data:")) {
      const value = line.slice(5).replace(/^ /, "");
      // Include framing so an endless event made of empty data lines is bounded too.
      this.eventBytes += Buffer.byteLength(value) + 1;
      if (this.eventBytes > 1024 * 1024) { this.disable(); return; }
      this.data.push(value);
    }
  }
  private observe(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const usage = value as Record<string, any>;
    const fields = {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheCreationInputTokens: usage.cache_creation_input_tokens,
      cacheReadInputTokens: usage.cache_read_input_tokens,
      cacheCreation5mTokens: usage.cache_creation?.ephemeral_5m_input_tokens,
      cacheCreation1hTokens: usage.cache_creation?.ephemeral_1h_input_tokens,
    };
    // Streaming usage is cumulative: overwrite only reported values, never sum deltas.
    for (const [key, value] of Object.entries(fields)) {
      const n = count(value);
      if (n !== null) (this.usage as unknown as Record<string, unknown>)[key] = n;
    }
  }
}

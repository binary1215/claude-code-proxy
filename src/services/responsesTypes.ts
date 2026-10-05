/** The adapter's deliberately bounded Responses/Anthropic interchange contract. */
export type JsonObject = Record<string, any>;

/** Emitted native IDs must remain valid when replayed with their tool results. */
export const MAX_TOOL_CALL_ID_LENGTH = 256;

export class ResponsesError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
  }
}

export interface ToolBinding {
  nativeName: string;
  name: string;
  namespace?: string;
  kind: "function" | "custom";
}

export interface StateContext {
  model: string;
  principal: string;
  upstream: string;
}

export interface ReasoningCodec {
  seal(block: JsonObject, context: StateContext, itemId: string): string;
  open(value: string, context: StateContext, itemId: string): JsonObject;
}

export interface PreparedResponsesRequest {
  nativeBody: JsonObject;
  tools: Map<string, ToolBinding>;
  stream: boolean;
  model: string;
}

export interface RequestTranslationOptions {
  codec: ReasoningCodec;
  context: StateContext;
  defaultMaxTokens: number;
  defaultThinkingBudget: number;
}

export interface ResponseTranslationOptions {
  model: string;
  tools: Map<string, ToolBinding>;
  seal: (block: JsonObject, itemId: string) => string;
}

/** Verified request contracts, not a model catalogue or an authorization list.
 * Exact IDs keep future, dated and provider-specific IDs on the legacy path.
 * Sources: Claude thinking-troubleshooting, effort and thinking documentation.
 */
export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type ClaudeThinkingType = "adaptive" | "enabled" | "disabled" | "between_tools";

export interface ClaudeModelPolicy {
  readonly maxOutputTokens: number;
  readonly defaultThinking: "adaptive" | "legacy";
  readonly thinkingTypes: readonly ClaudeThinkingType[];
  readonly effortLevels: readonly ClaudeEffort[];
  readonly defaultEffort: ClaudeEffort;
  readonly disabledMaxEffort?: "high";
  readonly betweenToolsMaxEffort?: "high";
  /** Whether the model accepts forced tools; manual thinking still forbids them. */
  readonly forcedToolUse: boolean;
}

const ALL_EFFORTS: readonly ClaudeEffort[] = Object.freeze(["low", "medium", "high", "xhigh", "max"]);
const LEGACY_EFFORTS: readonly ClaudeEffort[] = Object.freeze(["low", "medium", "high", "max"]);
const policies = new Map<string, Readonly<ClaudeModelPolicy>>();

function add(ids: readonly string[], policy: Omit<ClaudeModelPolicy, "maxOutputTokens" | "effortLevels"> &
  { effortLevels?: readonly ClaudeEffort[] }): void {
  const value: Readonly<ClaudeModelPolicy> = Object.freeze({ maxOutputTokens: 128_000,
    ...policy, thinkingTypes: Object.freeze([...policy.thinkingTypes]),
    effortLevels: policy.effortLevels ?? ALL_EFFORTS });
  for (const id of ids) policies.set(id, value);
}

add(["claude-fable-5-2", "claude-fable-5-1", "claude-mythos-5-2", "claude-mythos-5-1"], {
  defaultThinking: "adaptive", thinkingTypes: ["adaptive"], defaultEffort: "high", forcedToolUse: false,
});
add(["claude-fable-5", "claude-mythos-5"], {
  defaultThinking: "adaptive", thinkingTypes: ["adaptive"], defaultEffort: "high", forcedToolUse: true,
});
add(["claude-opus-5-5"], {
  defaultThinking: "adaptive", thinkingTypes: ["adaptive"], defaultEffort: "medium", forcedToolUse: false,
});
add(["claude-opus-5"], {
  defaultThinking: "adaptive", thinkingTypes: ["adaptive", "disabled"], defaultEffort: "high",
  disabledMaxEffort: "high", forcedToolUse: true,
});
add(["claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-5"], {
  defaultThinking: "adaptive", thinkingTypes: ["adaptive", "disabled"], defaultEffort: "high", forcedToolUse: true,
});
add(["claude-sonnet-5-5"], {
  defaultThinking: "adaptive", thinkingTypes: ["adaptive", "between_tools"], defaultEffort: "high",
  betweenToolsMaxEffort: "high", forcedToolUse: false,
});
add(["claude-haiku-5-5"], {
  defaultThinking: "adaptive", thinkingTypes: ["adaptive", "disabled"], defaultEffort: "medium",
  disabledMaxEffort: "high", forcedToolUse: true,
});
add(["claude-opus-4-6", "claude-sonnet-4-6"], {
  defaultThinking: "legacy", thinkingTypes: ["adaptive", "enabled", "disabled"],
  effortLevels: LEGACY_EFFORTS, defaultEffort: "high", forcedToolUse: true,
});

export function claudeModelPolicy(model: string): Readonly<ClaudeModelPolicy> | undefined {
  return policies.get(model);
}

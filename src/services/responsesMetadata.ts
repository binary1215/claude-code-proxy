import { type JsonObject, ResponsesError } from "./responsesTypes.js";

export const MESSAGE_METADATA_KEYS = ["container", "diagnostics", "stop_details"];
const record = (value: any): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: any): boolean => typeof value === "string" && value.length <= 4096;
const count = (value: any): boolean => Number.isSafeInteger(value) && value >= 0;
function check(valid: boolean): asserts valid {
  if (!valid) throw new ResponsesError("invalid_upstream_metadata", "The upstream response metadata was invalid or unsupported.", 502);
}
function shape(value: any, allowed: string[], required: string[] = allowed): asserts value is JsonObject {
  check(record(value) && Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key)));
}

/** Validate only declared native metadata, without changing its values or logging it.
 * Source: Anthropic Messages/RawMessageDeltaEvent schema; not server-tool support.
 */
export function nativeMetadata(source: JsonObject, initial: boolean): JsonObject {
  const result: JsonObject = {};
  for (const name of MESSAGE_METADATA_KEYS) {
    if (!Object.hasOwn(source, name)) continue;
    const value = source[name];
    check(value !== undefined && Buffer.byteLength(JSON.stringify(value)) <= 16 * 1024);
    if (value !== null) {
      if (name === "container") {
        shape(value, ["id", "expires_at", "skills"], ["id", "expires_at"]);
        check(text(value.id) && value.id.length > 0 && text(value.expires_at) && value.expires_at.length > 0);
        if (value.skills !== undefined && value.skills !== null) {
          check(Array.isArray(value.skills) && value.skills.length <= 20);
          for (const skill of value.skills) {
            shape(skill, ["type", "skill_id", "version"]);
            check(["anthropic", "custom"].includes(skill.type) && text(skill.skill_id) && skill.skill_id.length > 0 &&
              text(skill.version) && skill.version.length > 0);
          }
        }
      } else if (name === "diagnostics") {
        check(initial);
        shape(value, ["cache_miss_reason"]);
        const reason = value.cache_miss_reason;
        if (reason !== null) {
          check(record(reason));
          if (["model_changed", "system_changed", "tools_changed", "messages_changed"].includes(reason.type)) {
            shape(reason, ["type", "cache_missed_input_tokens"]);
            check(count(reason.cache_missed_input_tokens));
          } else {
            shape(reason, ["type"]);
            check(["previous_message_not_found", "unavailable"].includes(reason.type));
          }
        }
      } else {
        // message_start cannot already contain a final refusal. Nonstream final
        // details are delivered with the synthetic message_delta, not dropped.
        check(!initial);
        shape(value, ["type", "category", "explanation"]);
        check(value.type === "refusal" && (value.category === null ||
          ["cyber", "bio", "frontier_llm", "reasoning_extraction", "general_harms"].includes(value.category)) &&
          (value.explanation === null || text(value.explanation)));
      }
    }
    result[name] = JSON.parse(JSON.stringify(value));
  }
  return result;
}

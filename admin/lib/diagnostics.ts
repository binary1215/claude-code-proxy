/** Display-only explanations. They never infer gateway events from proxy rows. */
export const GATEWAY_DIAGNOSTIC_NOTICE =
  "LiteLLM rejections happen before this proxy: an expired gateway key (401) or a route permission failure (403) must be checked in the gateway response/logs. HTTP status alone does not identify which hop rejected a request. Responses adapter validation may also fail before a history row is created; check the client's error.code.";

export function upstreamDiagnosticLabel(reason: string | null | undefined): string {
  if (reason === "third_party_plan_usage_restriction") return "Third-party plan usage restriction (message-classified)";
  if (reason === "unknown_429") return "Unknown 429 (cause unconfirmed)";
  return reason ?? "Unknown / not recorded";
}

export function upstreamDiagnosticExplanation(reason: string | null | undefined, status: number | null | undefined): string | null {
  if (reason === "third_party_plan_usage_restriction") {
    return "The observed upstream 400 message describes third-party Claude-plan use drawing from extra usage. This is the proxy's classification, not a provider error code or proof of the detection trigger. It does not prove exhausted subscription allowance or authorize paid fallback. No retry or credential switch was performed by this classifier.";
  }
  if (status === 429 || reason === "unknown_429") {
    return "HTTP 429 alone does not establish quota exhaustion or missing entitlement. If the diagnostic is unknown, the cause is unconfirmed.";
  }
  if (status === 401 || status === 403) {
    return "This status was observed from the configured upstream, not from LiteLLM. Check the upstream authentication/permission response; it does not establish that the gateway key is expired or that its route is denied.";
  }
  return null;
}

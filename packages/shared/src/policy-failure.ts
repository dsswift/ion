/**
 * Policy Failure identifiers: the stable names of the failure states that
 * result from enterprise policy. Each is a key of the enterprise policy's
 * `messages` map and the value of `policyFailure` on the event, result, or
 * snapshot that reports the failure. Mirrors Go's PolicyFailureIDs.
 */
export const POLICY_FAILURES = [
  "model_not_allowed",
  "provider_not_authorized",
  "extension_blocked",
  "tool_blocked",
  "mcp_server_blocked",
  "profile_locked",
  "managed_policy_absent",
  "authentication_failed",
  "subscription_unavailable",
  "subscription_lookup_failed",
] as const;

export type PolicyFailure = (typeof POLICY_FAILURES)[number];

/**
 * The text a Policy Failure shows: the enterprise policy's replacement when
 * one is configured, `fallback` otherwise. A blank replacement counts as not
 * configured.
 */
export function policyMessage(
  messages: Record<string, string> | null | undefined,
  id: PolicyFailure,
  fallback: string,
): string {
  return messages?.[id] || fallback;
}

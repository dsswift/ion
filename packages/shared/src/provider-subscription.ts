import type { ProviderSubscriptionStatus } from "./types-engine-event-model";

/**
 * The answer to every `provider.*Subscription` studio_action. It carries the
 * engine's full snapshot even when the action failed, so a client always
 * holds the state the action left.
 */
export interface ProviderSubscriptionResult {
  ok: boolean;
  error?: string;
  subscription: ProviderSubscriptionStatus;
}

/**
 * The Provider Subscription states in which no looked-up key applies until a
 * person acts: several subscriptions with none chosen, or none at all.
 */
export type SubscriptionAttentionState = "selection_required" | "none";

/** The state that needs a person, or null when the snapshot needs nobody. */
export function subscriptionAttentionState(
  status: ProviderSubscriptionStatus | null | undefined,
): SubscriptionAttentionState | null {
  if (status?.state === "selection_required" || status?.state === "none") return status.state;
  return null;
}

/** The provider the key configures, as the model picker names it. */
export function subscriptionProviderName(status: ProviderSubscriptionStatus): string {
  return status.providerDisplayName || status.provider || "Provider";
}

/**
 * One environment's Provider Subscription Prompt: the snapshot that needs a
 * person, and whether they dismissed the prompt for it.
 */
export interface SubscriptionAttention {
  state: SubscriptionAttentionState;
  status: ProviderSubscriptionStatus;
  dismissed: boolean;
}

/**
 * Folds one snapshot into the prompt state. A dismissal lasts while the
 * snapshot stays in the same state, so the prompt shows once per transition
 * into a state and not again on each later snapshot of it.
 */
export function nextSubscriptionAttention(
  previous: SubscriptionAttention | null,
  status: ProviderSubscriptionStatus | null | undefined,
): SubscriptionAttention | null {
  const state = subscriptionAttentionState(status);
  if (!state || !status) return null;
  return { state, status, dismissed: previous?.state === state ? previous.dismissed : false };
}

/**
 * What a failure state says: the enterprise policy's text for it when one is
 * configured, `fallback` otherwise.
 */
export function subscriptionFailureText(status: ProviderSubscriptionStatus, fallback: string): string {
  return status.message || fallback;
}

/**
 * What a failed provider request says when the Provider Subscription state
 * explains it, or null when it does not.
 */
export function describeSubscriptionFailure(
  status: ProviderSubscriptionStatus | null | undefined,
): string | null {
  const state = subscriptionAttentionState(status);
  if (!state || !status) return null;
  const name = subscriptionProviderName(status);
  if (state === "selection_required") {
    return `No ${name} subscription is chosen yet, so this request had no subscription key. Choose a subscription, then try again.`;
  }
  return subscriptionFailureText(
    status,
    `The signed-in account has no ${name} subscription, so this request had no subscription key. Contact your administrator for access.`,
  );
}

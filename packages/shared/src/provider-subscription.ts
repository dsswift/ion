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

// EngineEvent model and telemetry variants.
//
// Extracted from types-engine-event.ts to keep the main wire-event union under
// the 600-line cap. EngineEvent includes this union unchanged, so consumers
// retain the same discriminated event surface.
import type { ModelTier } from "./types-model-tiers";
import type { SystemMetricsSample } from "./types-system-metrics";

export interface ProviderLoginUpdate {
  provider: string;
  backend: string;
  stage: string;
  authUrl?: string;
  userCode?: string;
  verificationUrl?: string;
  loginError?: string;
  loginId?: string;
}

export interface McpServerStatus {
  name: string;
  transport?: string;
  url?: string;
  command?: string;
  /** Stdio server arguments; absent for network transports. */
  args?: string[];
  /** Operator-configured OAuth client; absent when the server relies on discovery alone. */
  oauth?: McpOAuthStatus;
  connected: boolean;
  authenticated: boolean;
  toolCount?: number;
  protocolVersion?: string;
  capabilities?: string[];
  lastError?: string;
  /** A managed engine file defines this server; it cannot be updated or removed. */
  managed?: boolean;
}

/**
 * The operator-configured OAuth client for one MCP server. Empty fields are
 * filled from discovery at login. The secret is never reported.
 */
export interface McpOAuthStatus {
  clientId?: string;
  authUrl?: string;
  tokenUrl?: string;
  scope?: string;
  resource?: string;
  hasClientSecret?: boolean;
}

/** A Provider Subscription state. Each needs a different response from the operator. */
export type SubscriptionState =
  | "disabled"
  | "awaiting_identity"
  | "resolving"
  | "applied"
  | "selection_required"
  | "none"
  | "failed";

/** One subscription a lookup offered, without its key. */
export interface SubscriptionOption {
  id: string;
  label: string;
}

/**
 * Provider Subscription state: the provider key a lookup endpoint resolved
 * for the signed-in identity. A complete snapshot; consumers replace their
 * view with it. The key itself never leaves the engine.
 */
export interface ProviderSubscriptionStatus {
  state: SubscriptionState;
  provider?: string;
  /** The provider's configured display name; absent when none is set. */
  providerDisplayName?: string;
  /** The subscription whose key is applied; present only when applied. */
  selected?: SubscriptionOption;
  /** The subscriptions the last lookup returned, in response order. */
  options?: SubscriptionOption[];
  /** Where the applied key came from. */
  source?: "lookup" | "cache";
  /** When the lookup behind the key or options ran, Unix milliseconds. */
  resolvedAt?: number;
  /** The most recent lookup failure. Can accompany "applied" when a refresh failed. */
  error?: string;
  /** The Policy Failure identifier of the state; present when it is none or failed. */
  policyFailure?: string;
  /** The enterprise policy's text for policyFailure; absent when none is configured. */
  message?: string;
}

/** One usage window: the fraction (0..1) of it used and the unix second it resets. */
export interface RateLimitWindow {
  utilization: number;
  resetsAt: number;
}

/** What a backend reported about the signed-in account's usage limits during a run. */
export interface RateLimitPayload {
  /** The backend's verdict for the next request ("allowed", "allowed_warning", "rejected"). */
  status: string;
  /** Unix second the rateLimitType window resets. */
  resetsAt: number;
  /** The window the status is about ("five_hour", "seven_day"). */
  rateLimitType: string;
  /** Fraction (0..1) of the rateLimitType window used; absent when not reported. */
  utilization?: number;
  /** Every usage window reported with this event, keyed by window name. */
  windows?: Record<string, RateLimitWindow>;
}

export type EngineEventModel =
  // engine_rate_limit — INCREMENTAL: each event is one backend report and
  // stands alone.
  | { type: "engine_rate_limit"; rateLimit: RateLimitPayload }
  // engine_providers_updated — a payload-free nudge: provider sign-in or
  // model state may have changed, so re-read it.
  | { type: "engine_providers_updated" }
  | { type: "engine_provider_login"; providerLogin?: ProviderLoginUpdate }
  | { type: "engine_mcp_servers"; mcpServers?: McpServerStatus[] }
  // engine_provider_subscription — complete SNAPSHOT of the Provider
  // Subscription state, broadcast on every change and answered to the
  // provider_subscription_* commands. Consumers REPLACE their view with it.
  | { type: "engine_provider_subscription"; providerSubscription: ProviderSubscriptionStatus }
  | {
      type: "engine_model_tiers";
      modelTiers: ModelTier[];
    }
  | {
      type: "engine_telemetry_health";
      telemetryTarget: string;
      telemetryQueuedBatches?: number;
      telemetryQueuedEvents?: number;
      telemetryQueuedBytes?: number;
      telemetryOldestAgeMs?: number;
      telemetrySoftWarnBytes?: number;
      telemetryPercentOfSoftWarn?: number;
      telemetryCrossedThreshold?: number;
      telemetryHealthy: boolean;
      telemetryLastError?: string;
      telemetryCritical?: boolean;
      telemetryStuck?: boolean;
      telemetryStuckAfterMs?: number;
      telemetryMaxAttempts?: number;
      telemetryQuarantinedEvents?: number;
      telemetryQuarantinedBytes?: number;
    }
  | { type: "engine_default_provider"; defaultProvider?: string }
  | { type: "engine_system_metrics"; systemMetrics: SystemMetricsSample }
  | {
      type: "engine_capability_unsupported";
      capability: string;
      capabilityBackend: string;
      capabilityReason: string;
    }
  | { type: "engine_thinking_block_start" }
  | { type: "engine_thinking_delta"; thinkingText: string }
  | {
      type: "engine_thinking_block_end";
      thinkingTotalTokens?: number;
      thinkingElapsedSeconds?: number;
      thinkingRedacted?: boolean;
    };

// EngineEvent model and telemetry variants.
//
// Extracted from types-engine-event.ts to keep the main wire-event union under
// the 600-line cap. EngineEvent includes this union unchanged, so consumers
// retain the same discriminated event surface.
import type { ModelTier } from "./types-model-tiers";

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
  connected: boolean;
  authenticated: boolean;
  toolCount?: number;
  protocolVersion?: string;
  capabilities?: string[];
  lastError?: string;
}

export type EngineEventModel =
  | { type: "engine_provider_login"; providerLogin?: ProviderLoginUpdate }
  | { type: "engine_mcp_servers"; mcpServers?: McpServerStatus[] }
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

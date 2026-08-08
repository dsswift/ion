/**
 * log-egress-types.ts — shared shapes for the desktop egress forwarder.
 *
 * Split from log-egress.ts (600-line cap). These types are the contract
 * between the record producers (logger.ts, the file tailers), the forwarder
 * itself (log-egress-forwarder.ts), and the configuration surface
 * (app-lifecycle.ts). They are re-exported from log-egress.ts, which remains
 * the public entry point for this subsystem.
 */


/**
 * EgressRecord is the structured payload shipped to downstream egress targets.
 * Mirrors the canonical log schema (docs/observability/log-schema.md) so the
 * egress stream is parseable by the same tooling as the local JSONL file.
 *
 * The type is intentionally lenient (string | undefined) so verbatim records
 * from the engine or iOS tails (which may have additional fields) round-trip
 * without truncation — the extra fields survive in the spread.
 */
export interface EgressRecord {
  ts: string
  level: string
  msg: string
  component: string
  tag?: string
  session_id?: string
  conversation_id?: string
  trace_id?: string
  /**
   * User-attribution field (schema v3 — commit ed7e4b9c).
   * Set from the signed-in Entra identity (preferred_username claim, or
   * oid fallback). Omitted when no user is signed in (unauthenticated
   * telemetry is still accepted by a no-auth sink). See entra-auth.ts
   * for the claim-selection rationale.
   */
  user?: string
  /**
   * Per-record unique ID (16 hex chars), stamped at the enqueue funnel for
   * downstream dedup during retry storms. Byte-shape parity with the engine
   * egressRecord.event_id (engine/internal/utils/log_egress.go). A record that
   * already carries an event_id (e.g. a tailed telemetry event) keeps its own.
   */
  event_id?: string
  fields?: Record<string, unknown>
  [key: string]: unknown
}

/** Minimal OtelConfig shape needed by the forwarder (mirrors engine types.OtelConfig). */
export interface EgressOtelConfig {
  endpoint: string
  serviceName?: string
  headers?: Record<string, string>
}

/** Full egress config, sourced from engine.json LoggingConfig egress fields. */
export interface EgressConfig {
  /** Downstream shipping targets. "http" | "otel" (or both). */
  egressTargets: string[]
  /** HTTP POST URL for the "http" target. */
  egressEndpoint?: string
  /** Static headers for the "http" target (static per-config, not the auth seam). */
  egressHeaders?: Record<string, string>
  /** How many records to buffer before triggering an automatic flush. 0 = ticker only. */
  egressBatchSize?: number
  /** Flush interval in ms. Default 5000. */
  egressFlushIntervalMs?: number
  /** OTLP config for the "otel" target. */
  egressOtel?: EgressOtelConfig
  /**
   * Cap the on-disk spool file in bytes. When the spool exceeds this size,
   * the oldest lines are trimmed. Zero uses the default (50 MB).
   */
  egressSpoolMaxBytes?: number
}

/**
 * Pluggable auth-header provider. Called at send time so the token is always
 * fresh. Returns a map of headers to merge into the request (e.g.
 * { Authorization: "Bearer <token>" }).
 *
 * Part E wires in noopHeaderProvider (returns {}). Part F replaces this with
 * an Entra OIDC token provider.
 */
export type AuthHeaderProvider = () => Promise<Record<string, string>>

/** No-op provider for Part E — returns empty headers (no auth). */
export const noopHeaderProvider: AuthHeaderProvider = () => Promise.resolve({})

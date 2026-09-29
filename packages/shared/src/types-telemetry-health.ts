/**
 * The server's retained view of one telemetry egress target's delivery
 * health, built from the engine's `engine_telemetry_health` events. Published
 * on `ion:telemetry-health` as it changes and replayed on the Studio
 * snapshot, so a client that connects mid-outage sees the current state.
 */
export interface TelemetryHealthState {
  target: string
  queuedEvents: number
  queuedBytes: number
  oldestAgeMs: number
  percentOfSoftWarn: number
  healthy: boolean
  lastError?: string
  critical: boolean
  stuck: boolean
  maxAttempts: number
  quarantinedEvents: number
  quarantinedBytes: number
  updatedAt: number
}

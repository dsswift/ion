import { log, warn } from '../logger'
import { broadcast } from '../broadcast'
import type { EnterprisePolicy } from '@ion/shared/types-enterprise'
import type { TelemetryHealthState } from '@ion/shared/types-telemetry-health'

/**
 * Desktop consumer for the engine's `engine_telemetry_health` event
 * (issue #379).
 *
 * The engine reports the delivery health of each telemetry egress target and
 * has no opinion about what a consumer does with it. The desktop's opinion:
 * an operator whose audit stream has stopped arriving should be told while
 * the backlog is still draining, not when a downstream query later returns
 * nothing.
 *
 * Notifications are deliberately sparse. The engine already suppresses
 * steady-state growth and only reports threshold crossings, recovery, and
 * critical conditions, so this module notifies on what it receives rather
 * than adding a second layer of rate limiting — with one exception noted at
 * `shouldNotify`.
 */

/** Shape of the fields this consumer reads off the engine event. */
export interface TelemetryHealthEvent {
  type?: string
  telemetryTarget?: string
  telemetryQueuedEvents?: number
  telemetryQueuedBytes?: number
  telemetryOldestAgeMs?: number
  telemetrySoftWarnBytes?: number
  telemetryPercentOfSoftWarn?: number
  telemetryCrossedThreshold?: number
  telemetryHealthy?: boolean
  telemetryLastError?: string
  telemetryCritical?: boolean
  telemetryStuck?: boolean
  telemetryStuckAfterMs?: number
  telemetryMaxAttempts?: number
  telemetryQuarantinedEvents?: number
  telemetryQuarantinedBytes?: number
}

/** Latest known state per target, for a surface that wants to render it. */
export type { TelemetryHealthState } from '@ion/shared/types-telemetry-health'

const state = new Map<string, TelemetryHealthState>()

/** Current health of every target the engine has reported on. */
export function telemetryHealthState(): TelemetryHealthState[] {
  return [...state.values()]
}

/**
 * Whether this observation warrants interrupting the operator.
 *
 * A crossing, a critical condition, a newly stuck queue, or newly
 * quarantined events do. A recovery does only if we had previously warned
 * about that target — telling someone their telemetry recovered when they
 * were never told it was failing is noise, not news.
 */
function shouldNotify(evt: TelemetryHealthEvent, prev: TelemetryHealthState | undefined, hadWarned: boolean): boolean {
  if (evt.telemetryCritical) return true
  if ((evt.telemetryCrossedThreshold ?? 0) > 0) return true
  if (evt.telemetryStuck && !prev?.stuck) return true
  if ((evt.telemetryQuarantinedEvents ?? 0) > (prev?.quarantinedEvents ?? 0)) return true
  if (evt.telemetryHealthy && !evt.telemetryStuck && hadWarned) return true
  return false
}

function formatAge(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes >= 120) return `${Math.round(minutes / 60)} hours`
  if (minutes >= 1) return `${minutes} minute${minutes === 1 ? '' : 's'}`
  return `${Math.round(ms / 1000)} seconds`
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

/**
 * The operator-facing sentence for one observation. `prev` is the last state
 * seen for the target, used to tell a fresh quarantine apart from a stale
 * count riding along on an unrelated report.
 */
export function describeTelemetryHealth(evt: TelemetryHealthEvent, prev?: TelemetryHealthState): string {
  const target = evt.telemetryTarget || 'telemetry'
  if (evt.telemetryCritical) {
    return `Ion cannot save undelivered ${target} telemetry to disk (${evt.telemetryLastError ?? 'write failed'}). Events are being lost now.`
  }
  const quarantined = evt.telemetryQuarantinedEvents ?? 0
  if (quarantined > (prev?.quarantinedEvents ?? 0)) {
    const fresh = quarantined - (prev?.quarantinedEvents ?? 0)
    return `Ion could not send ${fresh} ${target} event${fresh === 1 ? '' : 's'} because ${fresh === 1 ? 'it is' : 'they are'} larger than the destination accepts. ${fresh === 1 ? 'It is' : 'They are'} kept on this machine in the quarantine file but ${fresh === 1 ? 'is' : 'are'} missing from the stream.`
  }
  if (evt.telemetryStuck) {
    const queued = evt.telemetryQueuedEvents ?? 0
    const attempts = evt.telemetryMaxAttempts ?? 0
    return `Ion's ${target} telemetry has been stuck for ${formatAge(evt.telemetryOldestAgeMs ?? 0)}. ${queued} event${queued === 1 ? '' : 's'} queued, ${attempts} delivery attempt${attempts === 1 ? '' : 's'} so far${evt.telemetryLastError ? ` (${evt.telemetryLastError})` : ''}. Events are preserved and will keep being retried.`
  }
  if (evt.telemetryHealthy) {
    return `Ion's ${target} telemetry backlog has cleared. Queued events were delivered.`
  }
  const queued = evt.telemetryQueuedEvents ?? 0
  const size = formatBytes(evt.telemetryQueuedBytes ?? 0)
  const pct = evt.telemetryPercentOfSoftWarn ?? 0
  return `Ion's ${target} telemetry is not being delivered. ${queued} event${queued === 1 ? '' : 's'} queued (${size}, ${pct}% of the warning threshold). Events are preserved and will be resent.`
}

/**
 * Whether telemetry-health notifications are permitted under the given
 * enterprise policy. Absent policy, or an absent/false flag, permits them —
 * the safe default for every unmanaged install. Exported as a pure function
 * (rather than inlined at the `installTelemetryHealthConsumer` call site) so
 * the enterprise-seal behavior is testable without standing up the real
 * engine bridge or enterprise-policy cache.
 */
export function telemetryHealthNotificationsEnabled(policy: EnterprisePolicy | null | undefined): boolean {
  return !policy?.disableTelemetryHealthNotifications
}

/** The studio_event channel every telemetry health report rides. */
export const TELEMETRY_HEALTH_CHANNEL = 'ion:telemetry-health'

/** One report as clients receive it: the retained state, the sentence, and whether the operator should be interrupted. */
export interface TelemetryHealthReport {
  state: TelemetryHealthState
  message: string
  /**
   * True when the report is worth a notification by the dedupe rule above
   * (a threshold crossing, a stuck backlog, a recovery after a warning). The
   * decision is made once, here, so every client agrees; whether to show a
   * system notification at all is each client's own policy.
   */
  notify: boolean
}

/**
 * Wire the consumer to the engine bridge. Every report is retained, logged,
 * and broadcast on `TELEMETRY_HEALTH_CHANNEL`; a desktop turns `notify`
 * into an OS notification (`desktop/src/main/telemetry-health-notifier.ts`)
 * under its own enterprise switch.
 */
export function installTelemetryHealthConsumer(
  engineBridge: { on: (ev: string, cb: (key: string, event: TelemetryHealthEvent) => void) => void },
): void {
  const warned = new Set<string>()

  engineBridge.on('event', (_key: string, event: TelemetryHealthEvent) => {
    if (event.type !== 'engine_telemetry_health') return

    const target = event.telemetryTarget || 'unknown'
    const prev = state.get(target)
    const next: TelemetryHealthState = {
      target,
      queuedEvents: event.telemetryQueuedEvents ?? 0,
      queuedBytes: event.telemetryQueuedBytes ?? 0,
      oldestAgeMs: event.telemetryOldestAgeMs ?? 0,
      percentOfSoftWarn: event.telemetryPercentOfSoftWarn ?? 0,
      healthy: event.telemetryHealthy ?? false,
      lastError: event.telemetryLastError,
      critical: event.telemetryCritical ?? false,
      stuck: event.telemetryStuck ?? false,
      maxAttempts: event.telemetryMaxAttempts ?? 0,
      quarantinedEvents: event.telemetryQuarantinedEvents ?? 0,
      quarantinedBytes: event.telemetryQuarantinedBytes ?? 0,
      updatedAt: Date.now(),
    }
    state.set(target, next)

    const message = describeTelemetryHealth(event, prev)
    // Always logged, notification or not: an operator with notifications
    // disabled still needs the record, and this is the only desktop-side
    // trace that the engine reported a delivery problem at all.
    const fields = {
      target,
      healthy: event.telemetryHealthy ?? false,
      critical: event.telemetryCritical ?? false,
      queued_events: event.telemetryQueuedEvents ?? 0,
      queued_bytes: event.telemetryQueuedBytes ?? 0,
      percent_of_soft_warn: event.telemetryPercentOfSoftWarn ?? 0,
      crossed_threshold: event.telemetryCrossedThreshold ?? 0,
      stuck: event.telemetryStuck ?? false,
      oldest_age_ms: event.telemetryOldestAgeMs ?? 0,
      max_attempts: event.telemetryMaxAttempts ?? 0,
      quarantined_events: event.telemetryQuarantinedEvents ?? 0,
    }
    if (event.telemetryCritical || event.telemetryStuck || !event.telemetryHealthy) {
      warn('telemetry_health', 'telemetry delivery degraded', fields)
    } else {
      log('telemetry_health', 'telemetry delivery healthy', fields)
    }

    const hadWarned = warned.has(target)
    const notify = shouldNotify(event, prev, hadWarned)
    if (notify) {
      if (event.telemetryHealthy && !event.telemetryStuck) warned.delete(target)
      else warned.add(target)
    }
    const report: TelemetryHealthReport = { state: next, message, notify }
    broadcast(TELEMETRY_HEALTH_CHANNEL, report)
  })
}

/** Test hook: drop retained state between cases. */
export function __resetTelemetryHealthForTest(): void {
  state.clear()
}

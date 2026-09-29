/**
 * Registry phase machine (spec 13, manifest C10). Pure functions the
 * registry uses to decide transitions from a broker `ConnectionPhase` push
 * plus its own `not_assigned`/`duplicate_server_id`/`hidden` classification
 * — the broker only knows about transport-level phases (connecting,
 * connected, backoff, offline); the registry layers the wider
 * `EnvironmentPhase` set on top.
 */
import type { ConnectionPhase } from '../../../shared/types-connections'
import type { EnvironmentPhase, EnvironmentReasonCode } from '@ion/shared/types-environments'

/** Classifies a broker refusal reason into the registry's reason vocabulary. */
export function classifyRefusal(refusalReason: string | undefined): EnvironmentReasonCode {
  switch (refusalReason) {
    case 'unauthorized':
      return 'not_assigned'
    case 'protocol_version':
      return 'protocol_version'
    case 'scope':
      return 'policy_disallowed'
    case 'engine_incompatible':
      return 'engine_lost'
    default:
      return 'unknown'
  }
}

/**
 * Maps a broker-level `ConnectionPhase` onto the registry's wider
 * `EnvironmentPhase` set. `blocked`/`hidden` are never produced here — they
 * are registry-only classifications applied by the caller before/after this
 * mapping runs (duplicate-id detection, assignment refusal).
 */
export function mapBrokerPhase(phase: ConnectionPhase): { phase: EnvironmentPhase; reason?: EnvironmentReasonCode } {
  switch (phase.phase) {
    case 'connecting':
      return { phase: 'connecting' }
    case 'connected':
      return { phase: 'connected' }
    case 'backoff':
      return { phase: 'backoff', reason: phase.refusalReason ? classifyRefusal(phase.refusalReason) : 'server_unreachable' }
    case 'offline':
      return { phase: 'offline', reason: phase.refusalReason ? classifyRefusal(phase.refusalReason) : 'server_unreachable' }
  }
}

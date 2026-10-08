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
/** Why a connection that is not up is not up, in the registry's reason vocabulary. */
function failureReason(phase: Extract<ConnectionPhase, { phase: 'backoff' | 'offline' }>): EnvironmentReasonCode {
  if (phase.refusalReason) return classifyRefusal(phase.refusalReason)
  return phase.incompatible ? 'protocol_version' : 'server_unreachable'
}

export function mapBrokerPhase(phase: ConnectionPhase): { phase: EnvironmentPhase; reason?: EnvironmentReasonCode } {
  switch (phase.phase) {
    case 'connecting':
      return { phase: 'connecting' }
    case 'connected':
      return { phase: 'connected' }
    case 'backoff':
      return { phase: 'backoff', reason: failureReason(phase) }
    case 'offline':
      return { phase: 'offline', reason: failureReason(phase) }
  }
}

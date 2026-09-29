/**
 * Connection phase types shared by the main-process broker/transports and
 * the renderer's `StudioHost` (spec 12). Lives in `shared/` — not
 * `main/connections/phases.ts` — because the renderer needs these types too,
 * and renderer code must not import from `main/` (desktop CLAUDE.md
 * "Renderer must not import IPC/Electron-bound code from `main/`").
 * `main/connections/phases.ts` re-exports this module so existing main-side
 * imports (`./phases`) keep working unchanged.
 *
 * A phase transition is always logged with `environment_id`, `phase`,
 * `reason`, `transport` (nonfunctional requirement: "every connection
 * transition logs...").
 */
import type { StudioRefusalReason } from '@ion/shared/studio-wire/types'

export type ConnectionTransportKind = 'local' | 'tcp' | 'relay'

export type ConnectionPhase =
  | { phase: 'connecting'; transport: ConnectionTransportKind }
  | { phase: 'connected'; transport: ConnectionTransportKind }
  | {
      phase: 'backoff'
      transport: ConnectionTransportKind
      reason: string
      /** The precise wire-level refusal, when the failure came from a `studio_refused` frame (spec 13 registry classification) rather than a transport error. */
      refusalReason?: StudioRefusalReason
      attempt: number
      nextAttemptAtMs: number
    }
  | { phase: 'offline'; transport: ConnectionTransportKind; reason: string; refusalReason?: StudioRefusalReason }

/** One environment's phase, as pushed to the renderer over `studio:connections`. */
export interface ConnectionPhaseSnapshot {
  environmentId: string
  label: string
  phase: ConnectionPhase
}

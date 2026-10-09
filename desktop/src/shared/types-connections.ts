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

/**
 * How a connection reaches its server. `ssh` is a TCP socket dialed at the
 * local end of an SSH forward this desktop opened; it is named apart from
 * `tcp` because the forward is a hop of its own and the wire-latency and
 * connect spans must not read an SSH round trip as a LAN one.
 */
export type ConnectionTransportKind = 'local' | 'tcp' | 'ssh' | 'relay'

export type ConnectionPhase =
  | { phase: 'connecting'; transport: ConnectionTransportKind }
  | { phase: 'connected'; transport: ConnectionTransportKind }
  | {
      phase: 'backoff'
      transport: ConnectionTransportKind
      reason: string
      /** The precise wire-level refusal, when the failure came from a `studio_refused` frame (spec 13 registry classification) rather than a transport error. */
      refusalReason?: StudioRefusalReason
      /** The server answered the hello with a welcome this client could not read: the two builds disagree on the wire. */
      incompatible?: boolean
      attempt: number
      nextAttemptAtMs: number
    }
  | {
      phase: 'offline'
      transport: ConnectionTransportKind
      reason: string
      refusalReason?: StudioRefusalReason
      /** The server answered the hello with a welcome this client could not read: the two builds disagree on the wire. */
      incompatible?: boolean
    }

/** One environment's phase, as pushed to the renderer over `studio:connections`. */
export interface ConnectionPhaseSnapshot {
  environmentId: string
  label: string
  phase: ConnectionPhase
}

/**
 * Environment catalog types (manifest contract C10, spec 13). An
 * `EnvironmentTarget` is one entry in `desktop.json`'s `environments[]`
 * array: the local server (implicit, never persisted as an entry itself),
 * a LAN- or relay-paired server, or a bearer-door server reached directly.
 *
 * Shared between the main-process catalog writer (`device-settings.ts`) and
 * the renderer's `connection/catalog.ts` so both validate the same shape.
 */

export type EnvironmentTargetKind = 'local' | 'paired' | 'bearer'

export interface LocalEnvironmentTarget {
  kind: 'local'
}

/**
 * How a paired server was reached and is dialed again:
 *  - `lan`: the server's advertised http(s) address, directly.
 *  - `relay`: an E2E channel through a relay server (`relayUrls`).
 *  - `ssh`: a loopback port forwarded over SSH to the server's own port on
 *    the host (`ssh`), opened by the desktop before every connect.
 */
export type PairedEnvironmentVia = 'lan' | 'relay' | 'ssh'

/** The SSH leg of a `via: 'ssh'` target. The local end of the forward is chosen per boot and never persisted. */
export interface SshEnvironmentLeg {
  /** `[user@]host` or an `~/.ssh/config` alias, exactly as the operator typed it (minus any `:port`). */
  destination: string
  /** SSH port when not the default. */
  port?: number
  /** The Studio server's TCP port on the host, the forward's remote end. */
  remotePort: number
}

export interface PairedEnvironmentTarget {
  kind: 'paired'
  label: string
  /**
   * The server's HTTP base as dialed for `lan`; for `ssh` it is
   * `http://127.0.0.1:<remotePort>` as seen from the host, and the desktop
   * substitutes the tunnel's local port at connect time.
   */
  url: string
  /** Key into the main-process credential store (`connections/credentials.ts`); never the secret itself. */
  credentialRef: string
  via: PairedEnvironmentVia
  relayUrls?: string[]
  /** Present exactly when `via === 'ssh'`. */
  ssh?: SshEnvironmentLeg
  /** The server's own environmentId, once learned from a `studio_welcome`. */
  environmentId?: string
  /** True when provisioned by an enterprise policy's `environments[]` list rather than added by hand. */
  managed?: boolean
}

export interface BearerEnvironmentTarget {
  kind: 'bearer'
  label: string
  url: string
  /** The server's sign-in, from its `/auth/config`. `clientId` is the app the person signs in as; absent, the audience is. */
  oidc?: { issuer: string; audience: string; scope: string; clientId?: string }
  environmentId?: string
  managed?: boolean
}

export type EnvironmentTarget = LocalEnvironmentTarget | PairedEnvironmentTarget | BearerEnvironmentTarget

/** The identifier reserved for the always-present local environment (never appears in `environments[]`). */
export const LOCAL_ENVIRONMENT_ID = 'local'

/**
 * How the always-present local environment is named to the person in front
 * of it. The host's platform decides: "This Mac" on macOS, "This PC" on
 * Windows and Linux. A caller that cannot name a platform (a host double
 * with no operating-system shell) reads as macOS, the label every screen
 * carried before the platform was consulted.
 */
export function localEnvironmentLabel(platform: string | undefined): string {
  return platform === undefined || platform === 'darwin' ? 'This Mac' : 'This PC'
}

export type EnvironmentViewFilter = 'all' | 'local' | string

/**
 * Registry connection phase (manifest C10), superset of the transport-level
 * `ConnectionPhase` in `types-connections.ts`: adds `blocked` (duplicate
 * server id) and `hidden` (assignment refused; retried on a schedule but
 * never shown in a picker).
 */
export type EnvironmentPhase = 'offline' | 'connecting' | 'backoff' | 'connected' | 'degraded' | 'blocked' | 'hidden'

/** Reason codes (manifest C10), logged on every registry transition. */
export type EnvironmentReasonCode =
  | 'not_assigned'
  | 'token_unavailable'
  | 'protocol_version'
  | 'duplicate_server_id'
  | 'credential_revoked'
  | 'policy_disallowed'
  | 'engine_lost'
  | 'server_unreachable'
  | 'slow_client'
  | 'unknown'

export interface EnvironmentPhaseState {
  phase: EnvironmentPhase
  reason?: EnvironmentReasonCode
  /** Set once the environment has produced a welcome (used to detect a duplicate id). */
  environmentId?: string
  lastAttemptAtMs?: number
  nextAttemptAtMs?: number
}

/** One catalog entry plus its live registry state, as the renderer's selectors join them. */
export interface EnvironmentCatalogEntry {
  /** Stable local key: `'local'` for the local entry, else the target's persisted index-derived id. */
  id: string
  label: string
  target: EnvironmentTarget
}

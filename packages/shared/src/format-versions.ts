/**
 * Format Versions: every versioned data format, stored schema, and wire
 * protocol an Ion build reads or writes, with the rule that decides whether
 * two builds can work together over it.
 *
 * The engine publishes its entries (engine/internal/compat) and the Studio
 * server publishes its own (server/src/compat/registry.ts) in this one shape,
 * so a consumer judges any pair of hosts without knowing any one format.
 */

/**
 * - `exact`: both ends must write and read the same version.
 * - `accepts-previous`: the receiver accepts its own version and the one before.
 * - `reader-at-least`: a reader handles every version up to its own.
 * - `host-storage`: data stored on the host; a lower version is a downgrade.
 * - `external`: spoken to a third party; never compared between Ion hosts.
 */
export type FormatRule = 'exact' | 'accepts-previous' | 'reader-at-least' | 'host-storage' | 'external'

export type FormatOwner = 'engine' | 'server'

export interface FormatVersion {
  id: string
  owner: FormatOwner
  /** A string so numeric versions and named ones (`ion-remote-v1`) share one shape. */
  version: string
  rule: FormatRule
  meaning: string
}

/** The app that runs this Studio server as its child, when one does. */
export interface HostApp {
  name: 'desktop'
  version: string
}

/**
 * `GET /versionz` on a Studio server's local listeners: what this running
 * server and its engine speak. Nothing in it is secret, so it needs no
 * credential, like `/healthz`.
 */
export interface ServerVersionReport {
  serverVersion: string
  /** The running engine's version; null when the engine is not reachable. */
  engineVersion: string | null
  /** `server.json`'s `engine.minVersion`. */
  engineMinVersion: string
  /** Whether the running engine meets `engineMinVersion`; null when it is not reachable. */
  engineMeetsMin: boolean | null
  hostApp: HostApp | null
  /** The server's formats, then the running engine's (absent when the engine is not reachable). */
  formats: FormatVersion[]
}

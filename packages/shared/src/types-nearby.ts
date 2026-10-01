/**
 * A Studio Server found on the LAN (`_ion-studio._tcp`). Only an address
 * book entry: finding one grants nothing, and pairing still needs the
 * one-time code its admin reads off the host.
 */
export interface NearbyStudioServer {
  /** The server's environment id, from the announcement. Empty when it sent none. */
  environmentId: string
  label: string
  serverVersion: string
  /** The name the server announced itself under, e.g. `oscar.local`. Shown, not dialled. */
  host: string
  port: number
  /**
   * The base a pairing completes against. Built from the announced IP where
   * there is one, because a server's announced NAME is whatever it calls
   * itself and frequently does not resolve (a bare `dcitag8331` for a Mac
   * that answers to `dcitag8331.local`).
   */
  url: string
}

/** How long one browse listens before answering. */
export const NEARBY_BROWSE_MS = 4000

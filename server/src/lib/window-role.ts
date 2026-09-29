/**
 * window-role — whether this process holds the session store as its OWNER or
 * as a MIRROR of a server's store.
 *
 *   - 'server' → the server process: the one store that persists tabs,
 *     answers snapshot polls, and runs owner-only reducer side effects.
 *   - 'studio' → a Studio client, in an Electron window or a browser tab: it
 *     consumes the servers' event streams, forwards owner-durable mutations,
 *     and never persists.
 *
 * The role is declared, not detected. Studio's mirror boot calls
 * `declareMirrorWindow()` before anything reads the store, so the answer does
 * not depend on which HTML entry loaded the bundle (the browser build serves
 * Studio as `index.html`). A process that never declares is the owner.
 */
export type WindowRole = 'server' | 'studio'

let role: WindowRole = 'server'

/** Mark this process as a Studio mirror. Called once by the mirror boot. */
export function declareMirrorWindow(): void {
  role = 'studio'
}

export function windowRole(): WindowRole {
  return role
}

export function isMirrorWindow(): boolean {
  return role === 'studio'
}

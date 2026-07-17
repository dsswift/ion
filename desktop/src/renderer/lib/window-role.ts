/**
 * window-role — which renderer window this code is running in.
 *
 * The desktop has two renderer windows built from two entries:
 *   - index.html → the overlay (the session-store OWNER: persists tabs,
 *     answers snapshot polls, runs the prompt pipeline)
 *   - atv.html → the ATV shell (a session-store MIRROR: consumes the same
 *     event stream, forwards owner-only mutations, never persists)
 *
 * Detection is by entry file, not a boot flag, so there is no init-order
 * dependency: any module (including sessionStore at import time) can ask.
 * See docs/architecture/adr on the ATV shell mirror store for the contract.
 */
export function isMirrorWindow(): boolean {
  try {
    return typeof window !== 'undefined' && window.location.pathname.endsWith('atv.html')
  } catch {
    return false
  }
}

import { useSessionStore } from '../stores/sessionStore'
import { rDebug } from '../rendererLogger'

/**
 * Flip permission mode in the renderer that owns authoritative active-tab
 * state. In Studio, mirror action forwarding runs the read-plus-write atomically
 * in Overlay, never from a potentially stale mirrored instance.
 */
export function toggleActivePermissionMode(): void {
  rDebug('shortcuts', 'toggling active permission mode')
  useSessionStore.getState().togglePermissionMode('keyboard')
}

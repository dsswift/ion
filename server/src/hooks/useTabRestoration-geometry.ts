import type { PersistedTabState } from '@ion/shared/types'
import { useSessionStore } from '../store/sessionStore'

/**
 * Restore persisted popup geometry as-is.
 *
 * This used to clamp each geometry to `window.innerWidth`/`innerHeight`
 * before restoring it -- a viewport-bound check that made sense when this
 * code ran once, in the single Overlay renderer that owned the store. Since
 * the server-owned store migration (ADR-033) this function runs in the
 * headless server process at boot, which has no `window` at all and no
 * single "the" viewport to clamp against (several clients with different
 * screen sizes can all be looking at the same store). Every consumer of
 * this geometry already clamps it to ITS OWN real viewport when it renders
 * -- `FloatingPanel.tsx`'s `clampToViewport` (Plan/AgentDetail/ImageViewer)
 * and `useFileEditorPanel.ts`'s `clampToViewport` (the file editor) both
 * re-clamp on mount and on resize. Clamping here too was always redundant
 * with those and, since the migration, threw `ReferenceError: window is
 * not defined` on every boot -- caught by bootRestoreTabs()'s outer
 * catch and logged as "boot tab restoration failed", silently aborting
 * the rest of tab restoration on every single server start.
 */
export function restoreGlobalGeometry(saved: PersistedTabState): void {
  if (saved.editorGeometry) {
    useSessionStore.setState({ editorGeometry: saved.editorGeometry })
  }
  if (saved.planGeometry) {
    useSessionStore.setState({ planGeometry: saved.planGeometry })
  }
  if (saved.agentDetailGeometry) {
    useSessionStore.setState({ agentDetailGeometry: saved.agentDetailGeometry })
  }
}

import { usePreferencesStore } from '../../preferences'
import { useSessionStore } from '../../stores/sessionStore'
import { useSurfaceStore } from './surface-store'
import { rInfo } from '../../rendererLogger'

let unsubscribe: (() => void) | null = null

/** Keep the window-local surface store aligned with the mirror's active conversation. */
export function initSurfaceConversationSync(): () => void {
  if (unsubscribe) return unsubscribe
  const select = (): void => {
    const next = useSessionStore.getState().activeTabId
    const previous = useSurfaceStore.getState().currentConversationId
    // The surface is keyed by this id. If it changes for a conversation the
    // operator considers "the same one", every tab stored under the old key is
    // orphaned — which is what 561 stored records against 37 live tabs looks
    // like. Logged on every change so a key switch is visible rather than
    // inferred from missing tabs.
    if (next !== previous) {
      rInfo('studio.surface', 'surface conversation key changed', {
        from: previous ?? 'none',
        to: next ?? 'none',
      })
    }
    useSurfaceStore.getState().selectConversation(next)
  }
  const offSession = useSessionStore.subscribe((state, previous) => {
    if (state.activeTabId !== previous.activeTabId) select()
  })
  const offPreference = usePreferencesStore.subscribe((state, previous) => {
    if (state.studioSurfaceSwitchMode !== previous.studioSurfaceSwitchMode) select()
  })
  select()
  unsubscribe = () => {
    offSession()
    offPreference()
    unsubscribe = null
  }
  return unsubscribe
}

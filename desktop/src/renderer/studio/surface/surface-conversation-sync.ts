import { usePreferencesStore } from '../../preferences'
import { useSessionStore } from '../../stores/sessionStore'
import { useSurfaceStore } from './surface-store'

let unsubscribe: (() => void) | null = null

/** Keep the window-local surface store aligned with the mirror's active conversation. */
export function initSurfaceConversationSync(): () => void {
  if (unsubscribe) return unsubscribe
  const select = (): void => useSurfaceStore.getState().selectConversation(useSessionStore.getState().activeTabId)
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

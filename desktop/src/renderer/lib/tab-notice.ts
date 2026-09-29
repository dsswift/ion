/**
 * tab-notice — a short message shown over one conversation, for a click the
 * operator made that could not do what they asked. It rides the same toast
 * list the engine's own notices use, so it looks and dismisses the same way.
 */
import { useSessionStore } from '@ion/server/store/sessionStore'

let counter = 0

export function showTabNotice(tabId: string, message: string, level: 'info' | 'warning' | 'error' = 'warning'): void {
  useSessionStore.setState((state) => {
    const notifications = new Map(state.engineNotifications)
    const list = [...(notifications.get(tabId) ?? [])]
    list.push({ id: `tab-notice-${Date.now()}-${++counter}`, message, level, timestamp: Date.now() })
    notifications.set(tabId, list)
    return { engineNotifications: notifications }
  })
}

/**
 * select-when-present — makes a conversation created on another
 * environment the active one.
 *
 * A create on the local environment is selected by the local server: its
 * tabs-sync carries the new active tab and the union hydration adopts it.
 * A create on a remote environment is different: the action result names
 * the new tab, but the tab itself only reaches this window a moment later
 * on that environment's tabs-sync, and the hydration deliberately keeps
 * the current active tab when a remote list arrives (another device's
 * activity must not steal focus here). So the creator selects it: wait
 * for the tab to appear in the union store, then run the ordinary
 * `selectTab`, which the mirror applies optimistically and forwards to
 * the owning environment. Bounded, so a create whose sync never lands
 * (the connection dropped) does not leave a dangling subscription.
 */
import { useSessionStore } from '@ion/server/store/sessionStore'
import { rInfo, rWarn } from '../../rendererLogger'

const TAG = 'select-when-present'

export function selectTabWhenPresent(tabId: string, timeoutMs = 10_000): Promise<boolean> {
  const has = (): boolean => useSessionStore.getState().tabs.some((t) => t.id === tabId)
  const select = (): void => {
    useSessionStore.getState().selectTab(tabId)
    rInfo(TAG, 'selected newly created tab', { tab_id: tabId })
  }
  if (has()) {
    select()
    return Promise.resolve(true)
  }
  rInfo(TAG, 'tab not in the union store yet; waiting for its environment sync', { tab_id: tabId, timeout_ms: timeoutMs })
  return new Promise((resolve) => {
    let done = false
    const finish = (found: boolean): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      unsubscribe()
      if (found) select()
      else rWarn(TAG, 'tab never arrived; not selected', { tab_id: tabId, timeout_ms: timeoutMs })
      resolve(found)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    const unsubscribe = useSessionStore.subscribe(() => { if (has()) finish(true) })
    if (has()) finish(true)
  })
}

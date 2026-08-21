/**
 * Canvas-tab command handlers.
 *
 * One toggle rule for every canvas tab: if the tab is already the active one,
 * close it; otherwise reveal the canvas pane and make that tab active. The
 * pane is opened on demand because a chord that silently activated a tab
 * behind a hidden pane would look like nothing happened.
 */

import { useSurfaceStore } from './surface-store'
import { CANVAS_TAB_COMMANDS, type CanvasTabId } from './canvas-tab-commands'
import { NOTIFICATION_SURFACE_ID, type SingletonId } from '../../../shared/studio-surface-types'
import type { ShortcutHandlers } from '../../shortcuts/shortcut-types'
import { rDebug } from '../../rendererLogger'

/** Toggle one canvas singleton, opening the canvas pane when it is hidden. */
function toggleSingleton(id: SingletonId): void {
  const store = useSurfaceStore.getState()
  if (store.activeTabId === id) {
    rDebug('studio.surface', 'canvas tab closed by shortcut', { surface_tab: id })
    store.closeTab(id)
    return
  }
  if (!store.visible) store.setVisible(true)
  store.openSingleton(id)
  rDebug('studio.surface', 'canvas tab opened by shortcut', { surface_tab: id })
}

/**
 * Toggle the workspace notification tab.
 *
 * Unlike a singleton, this tab cannot be created from a keystroke: it carries a
 * specific resource that only a published notification supplies. With no
 * notification open the chord is a no-op, logged so the dead press is visible.
 */
function toggleNotification(): void {
  const store = useSurfaceStore.getState()
  if (!store.notification) {
    rDebug('studio.surface', 'notification shortcut ignored: no notification open', {})
    return
  }
  if (store.activeTabId === NOTIFICATION_SURFACE_ID) {
    store.closeTab(NOTIFICATION_SURFACE_ID)
    rDebug('studio.surface', 'notification tab closed by shortcut', {})
    return
  }
  if (!store.visible) store.setVisible(true)
  store.activateTab(NOTIFICATION_SURFACE_ID)
  rDebug('studio.surface', 'notification tab focused by shortcut', {})
}

/**
 * Every canvas-tab command, keyed by command id. Spread into the shell's
 * handler map so a newly bound canvas tab needs no shell edit.
 */
export function canvasTabHandlers(): ShortcutHandlers {
  const handlers: ShortcutHandlers = {}
  for (const [tabId, commandId] of Object.entries(CANVAS_TAB_COMMANDS) as Array<[CanvasTabId, string]>) {
    handlers[commandId] =
      tabId === NOTIFICATION_SURFACE_ID
        ? () => toggleNotification()
        : () => toggleSingleton(tabId)
  }
  return handlers
}

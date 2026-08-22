/**
 * studio-beacon — attention signal when a permission/plan/question arrives
 * while the Studio window is open but not focused: dock bounce (macOS) or
 * frame flash, plus a title prefix cleared on focus. Main-process so it
 * works even when the renderer is throttled.
 */
import { app } from 'electron'
import { state } from './state'
import { readSettings } from './settings-store'
import { log as _log } from './logger'
import type { NormalizedEvent } from '../shared/types'

const TITLE = 'Ion'
const ATTENTION_TITLE = '● Ion — needs you'

export type BeaconAction = 'bounce' | 'title'

/** Pure: which beacon actions fire for an event given focus + setting. */
export function shouldBeacon(event: NormalizedEvent, studioOpen: boolean, studioFocused: boolean, enabled: boolean): BeaconAction[] {
  if (!enabled || !studioOpen || studioFocused) return []
  if (event.type !== 'permission_request') return []
  return ['bounce', 'title']
}

/** Fire the beacon for an inbound event (called from the broadcast tap). */
export function maybeBeacon(event: NormalizedEvent): void {
  const win = state.studioWindow
  const open = win != null && !win.isDestroyed()
  let enabled = true
  try {
    enabled = readSettings().studioBeacon !== false
  } catch {
    // Unreadable settings: default enabled.
  }
  const actions = shouldBeacon(event, open, open ? win!.isFocused() : false, enabled)
  if (actions.length === 0) return
  if (process.platform === 'darwin') {
    try {
      app.dock?.bounce('informational')
    } catch {
      // Dock may be hidden (accessory without dock presence) — title still signals.
    }
  } else if (win) {
    win.flashFrame(true)
  }
  win?.setTitle(ATTENTION_TITLE)
  _log('studio', 'beacon fired', { question_id: (event as { questionId?: string }).questionId ?? '' })
}

/** Restore the calm title (wired to the Studio window's focus event). */
export function clearBeacon(): void {
  const win = state.studioWindow
  if (!win || win.isDestroyed()) return
  if (win.getTitle() !== TITLE) win.setTitle(TITLE)
  if (process.platform !== 'darwin') win.flashFrame(false)
}

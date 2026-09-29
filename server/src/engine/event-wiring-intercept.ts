// Intercept event routing for engine_intercept events.
//
// The engine emits engine_intercept as a fire-and-forget signal on a target
// session's stream. The desktop is the coordinator: it checks which devices
// have this tab focused, reads per-device and per-desktop intercept preferences,
// and decides what to do with the level hint:
//
//   "banner"   — forward to renderer + focused iOS devices. No run change.
//   "redirect" — if any device with intercept enabled has this tab focused:
//                abort the active run, re-prompt with interceptMessage, and
//                forward the event to renderer + focused iOS devices.
//                If no device has intercept enabled: downgrade to banner.
//
// The engine has no opinion about what happens after it emits the event.

import type { EngineEvent } from '@ion/shared/types'
import { log as _log } from '../logger'
import { engineBridge, deviceFocusMap } from '../state'
import { thinConnections } from '../thin-view/remote-out'
import { focusedTabOf } from '../protocol/presence'
import { readSettings, SETTINGS_DEFAULTS } from '../persistence/settings-store'
import { focusState } from '../git/focus-state'
import { useSessionStore } from '../store/sessionStore'
import { handleEngineInterceptEvent } from '../store/slices/engine-event-slice-intercept'

const TAG = 'intercept'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }

/**
 * handleInterceptEvent is called when an engine_intercept event arrives on any
 * session stream (engine tab or CLI tab). tabId is the bare tab ID; event is
 * the raw EngineEvent from the engine.
 *
 * Routing logic:
 *   1. Read desktop intercept preference from settings.
 *   2. Read desktop active tab from focusState (window focus) — if the window
 *      is focused and the desktop's activeTabId matches, desktop is "focused".
 *   3. Iterate deviceFocusMap for iOS devices focused on this tab.
 *   4. Decide banner vs redirect vs downgraded-redirect.
 *   5. Record the inline banner in the tab's conversation (the store), which
 *      every client renders from.
 *   6. For redirect: abort + re-prompt after a short delay.
 */
export async function handleInterceptEvent(tabId: string, event: Extract<EngineEvent, { type: 'engine_intercept' }>): Promise<void> {
  const level = event.interceptLevel || 'banner'
  const title = event.interceptTitle || ''
  const message = event.interceptMessage || ''
  const source = event.interceptSource

  log('intercept_event', { tab_id: tabId, level, source: source ?? 'unknown' })

  // ── Desktop focus check ────────────────────────────────────────────────────
  // The desktop's intercept preference is read from settings each time so it
  // reflects live changes without needing a restart.
  const settings = readSettings()
  const desktopInterceptEnabled = settings.interceptEnabled !== undefined
    ? (settings.interceptEnabled as boolean)
    : SETTINGS_DEFAULTS.interceptEnabled

  // Read activeTabId directly: the store lives in this process (no window,
  // no executeJavaScript hop).
  const desktopActiveTabId: string | null = useSessionStore.getState().activeTabId ?? null

  // Raw LOCAL window focus, deliberately not the mixed attention signal
  // (focusState.focused is true when a remote client is connected, which says
  // nothing about whether a person is looking at the desktop window).
  const desktopWindowFocused = focusState.windowFocused
  const desktopHasTabFocused = desktopWindowFocused && desktopActiveTabId === tabId

  log('intercept_event: desktop_state', { window_focused: desktopWindowFocused, active_tab: desktopActiveTabId ?? '', tab_focused: desktopHasTabFocused, intercept_enabled: desktopInterceptEnabled })

  // ── iOS device focus check ─────────────────────────────────────────────────
  const focusedDevices: Array<{ deviceId: string; interceptEnabled: boolean }> = []
  for (const [deviceId, focus] of deviceFocusMap.entries()) {
    if (focus.tabId === tabId) {
      focusedDevices.push({ deviceId, interceptEnabled: focus.interceptEnabled })
      log('intercept_event: device_focused', { device_id: deviceId, tab_id: tabId, intercept_enabled: focus.interceptEnabled })
    }
  }

  // ── Thin Studio-wire client focus check ────────────────────────────────────
  // A thin client reports the same two facts through `presence.focus`.
  const focusedThin = thinConnections().filter((conn) => focusedTabOf(conn) === tabId)
  for (const conn of focusedThin) {
    focusedDevices.push({ deviceId: conn.id, interceptEnabled: conn.interceptEnabled })
    log('intercept_event: thin_client_focused', { connection_id: conn.id, tab_id: tabId, intercept_enabled: conn.interceptEnabled })
  }

  // ── Determine effective action ─────────────────────────────────────────────
  const desktopWillAct = desktopHasTabFocused && desktopInterceptEnabled
  const anyIosWillAct = focusedDevices.some(d => d.interceptEnabled)
  const anyDeviceWillAct = desktopWillAct || anyIosWillAct

  let effectiveLevel = level
  if (level === 'redirect' && !anyDeviceWillAct) {
    effectiveLevel = 'banner'
    log('intercept_event: downgrading to banner', { tab_id: tabId })
  }

  log('intercept_event: routing', { effective_level: effectiveLevel, desktop_will_act: desktopWillAct, any_ios_will_act: anyIosWillAct })

  // ── Record in the conversation ─────────────────────────────────────────────
  // Always insert the inline banner (or redirect marker) into the tab's
  // scrollback. The store lives in this process: Studio renders it from the
  // store's own sync, and a thin client receives it on its transcript stream.
  handleEngineInterceptEvent(useSessionStore.setState, tabId, {
    interceptLevel: effectiveLevel,
    interceptTitle: title,
    interceptMessage: message,
  })
  log('intercept_event: banner recorded', { tab_id: tabId, effective_level: effectiveLevel })

  // ── Redirect: abort + re-prompt ────────────────────────────────────────────
  if (level === 'redirect' && anyDeviceWillAct && message) {
    log('intercept_event: redirect', { tab_id: tabId })
    engineBridge.sendAbort(tabId)

    // Brief delay to let the abort land before submitting the new prompt.
    // The engine processes commands sequentially on the session stream;
    // 300ms is conservative — the abort command and the new send_prompt
    // will arrive on the socket in order regardless of this delay, but we
    // give the engine time to tear down the run and return to idle first.
    await new Promise<void>(resolve => setTimeout(resolve, 300))

    const promptResult = await engineBridge.sendPrompt(tabId, message)
    if (!promptResult.ok) {
      log('intercept_event: redirect re-prompt failed', { tab_id: tabId, error: promptResult.error ?? 'unknown error' })
    } else {
      log('intercept_event: redirect re-prompt sent', { tab_id: tabId, message_len: message.length })
    }
  }
}

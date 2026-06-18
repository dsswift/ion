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

import { IPC } from '../shared/types'
import type { EngineEvent } from '../shared/types'
import { log as _log } from './logger'
import { state, engineBridge, deviceFocusMap } from './state'
import { broadcast } from './broadcast'
import { readSettings, SETTINGS_DEFAULTS } from './settings-store'
import { focusState } from './git/focus-state'

const TAG = 'intercept'
function log(msg: string): void { _log(TAG, msg) }

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
 *   5. Forward event to renderer via broadcast.
 *   6. Forward to relevant iOS devices via remoteTransport.
 *   7. For redirect: abort + re-prompt after a short delay.
 */
export async function handleInterceptEvent(tabId: string, event: Extract<EngineEvent, { type: 'engine_intercept' }>): Promise<void> {
  const level = event.interceptLevel || 'banner'
  const title = event.interceptTitle || ''
  const message = event.interceptMessage || ''
  const source = event.interceptSource
  const metadata = event.interceptMetadata

  log(`handleInterceptEvent: tabId=${tabId} level=${level} title=${JSON.stringify(title)} source=${source ?? 'unknown'}`)

  // ── Desktop focus check ────────────────────────────────────────────────────
  // The desktop's intercept preference is read from settings each time so it
  // reflects live changes without needing a restart.
  const settings = readSettings()
  const desktopInterceptEnabled = settings.interceptEnabled !== undefined
    ? (settings.interceptEnabled as boolean)
    : SETTINGS_DEFAULTS.interceptEnabled

  // Try to read activeTabId from the renderer store. We do this via
  // executeJavaScript since the main process has no direct store reference.
  let desktopActiveTabId: string | null = null
  if (state.mainWindow) {
    try {
      desktopActiveTabId = await state.mainWindow.webContents.executeJavaScript(`
        (function() {
          var store = window.__Ion_SESSION_STORE__;
          return store ? (store.getState().activeTabId || null) : null;
        })()
      `)
    } catch {
      desktopActiveTabId = null
    }
  }

  const desktopWindowFocused = focusState.focused
  const desktopHasTabFocused = desktopWindowFocused && desktopActiveTabId === tabId

  log(`handleInterceptEvent: desktop windowFocused=${desktopWindowFocused} activeTabId=${desktopActiveTabId ?? 'null'} tabFocused=${desktopHasTabFocused} interceptEnabled=${desktopInterceptEnabled}`)

  // ── iOS device focus check ─────────────────────────────────────────────────
  const focusedDevices: Array<{ deviceId: string; interceptEnabled: boolean }> = []
  for (const [deviceId, focus] of deviceFocusMap.entries()) {
    if (focus.tabId === tabId) {
      focusedDevices.push({ deviceId, interceptEnabled: focus.interceptEnabled })
      log(`handleInterceptEvent: device=${deviceId} focused on tab=${tabId} interceptEnabled=${focus.interceptEnabled}`)
    }
  }

  // ── Determine effective action ─────────────────────────────────────────────
  const desktopWillAct = desktopHasTabFocused && desktopInterceptEnabled
  const anyIosWillAct = focusedDevices.some(d => d.interceptEnabled)
  const anyDeviceWillAct = desktopWillAct || anyIosWillAct

  let effectiveLevel = level
  if (level === 'redirect' && !anyDeviceWillAct) {
    effectiveLevel = 'banner'
    log(`handleInterceptEvent: downgrading redirect to banner — no device has intercept enabled for tabId=${tabId}`)
  }

  log(`handleInterceptEvent: effectiveLevel=${effectiveLevel} desktopWillAct=${desktopWillAct} anyIosWillAct=${anyIosWillAct}`)

  // ── Forward to renderer ────────────────────────────────────────────────────
  // Always forward the raw engine event to the renderer so it can render the
  // appropriate inline UI (banner card or redirect marker). The renderer's
  // engine-event-slice handles engine_intercept directly.
  broadcast(IPC.ENGINE_EVENT, tabId, event)

  // ── Forward to focused iOS devices ────────────────────────────────────────
  if (state.remoteTransport && focusedDevices.length > 0) {
    const remotePayload = {
      type: 'desktop_intercept' as const,
      tabId,
      level: effectiveLevel,
      title,
      message,
      source,
      metadata,
    }
    for (const device of focusedDevices) {
      log(`handleInterceptEvent: forwarding to device=${device.deviceId} effectiveLevel=${effectiveLevel}`)
      state.remoteTransport.sendToDevice(device.deviceId, remotePayload)
    }
  }

  // ── Redirect: abort + re-prompt ────────────────────────────────────────────
  if (level === 'redirect' && anyDeviceWillAct && message) {
    log(`handleInterceptEvent: redirect — aborting tabId=${tabId} then re-prompting`)
    engineBridge.sendAbort(tabId)

    // Brief delay to let the abort land before submitting the new prompt.
    // The engine processes commands sequentially on the session stream;
    // 300ms is conservative — the abort command and the new send_prompt
    // will arrive on the socket in order regardless of this delay, but we
    // give the engine time to tear down the run and return to idle first.
    await new Promise<void>(resolve => setTimeout(resolve, 300))

    const promptResult = await engineBridge.sendPrompt(tabId, message)
    if (!promptResult.ok) {
      log(`handleInterceptEvent: redirect re-prompt failed for tabId=${tabId}: ${promptResult.error ?? 'unknown error'}`)
    } else {
      log(`handleInterceptEvent: redirect re-prompt sent tabId=${tabId} messageLen=${message.length}`)
    }
  }
}

/**
 * IPC surface for the Agent Team Visualizer window.
 *
 * All handlers validate renderer-supplied input per ipc-validation.ts
 * conventions before any side effect. Settings writes go through a key
 * allowlist so the ATV window can never mutate arbitrary settings.
 */
import { app, dialog, ipcMain } from 'electron'
import { writeFile } from 'fs/promises'
import { join } from 'path'
import { IPC } from '../../shared/types'
import { log as _log } from '../logger'
import { state } from '../state'
import { isValidSessionId } from '../ipc-validation'
import { openAtvWindow, applyAtvActivationPolicy, isAtvWindowOpen } from '../atv-window-manager'
import { showWindow } from '../window-manager'
import { getAtvState, allAtvSummaries } from '../atv-state-cache'
import { listThemePacks, readPackBundle, readThemeAsset } from '../atv-theme-packs'
import { getRemoteTabStates } from '../remote/snapshot'
import { readSettings, writeSettings, SETTINGS_DEFAULTS } from '../settings-store'
import { validForwardedAction } from '../../shared/atv-mirror-actions'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('atv', msg, fields)
}

/**
 * The only settings keys the ATV window may read or write. All are
 * desktop-only: none appear in the iOS projectable allowlist.
 */
const ATV_SETTING_KEYS = new Set(['atvTheme', 'atvPinned', 'atvZoom', 'atvSeed', 'atvDockPresence', 'atvAutoDrawer', 'atvHeat', 'atvBeacon', 'atvSound', 'atvLayout'])

/**
 * How long a mirror-initiated action call waits for the owner renderer's reply.
 *
 * Generous on purpose: a forwarded action can open a confirm dialog or run git,
 * so this is a "the owner is gone or wedged" backstop rather than a latency
 * budget. The mirror caller gets a resolved refusal at the deadline instead of a
 * promise that never settles.
 */
const ATV_CALL_TIMEOUT_MS = 30_000

/**
 * How long the reply listener lingers past the deadline so a late reply can be
 * logged before the listener is released.
 *
 * The value is not delivered — the caller was already resolved — but the fact
 * that a reply arrived just too late is the signal that ATV_CALL_TIMEOUT_MS is
 * too tight for that action, which in the log is otherwise indistinguishable
 * from an owner that never answered at all.
 */
const ATV_LATE_REPLY_GRACE_MS = 10_000

/**
 * Reply envelope for ATV_CALL_ACTION.
 *
 * `ok` describes the ROUND TRIP, not the action's own success: `ok: true` means
 * the owner ran the action and `value` is whatever it returned (which may itself
 * be a `{ ok: false }` domain result). `ok: false` means the call never reached
 * a conclusion — rejected, no owner window, or no reply before the deadline.
 * Collapsing the two would make "the worktree refused to retire" and "the owner
 * window is gone" indistinguishable at the call site.
 */
interface AtvActionReply {
  ok: boolean
  value?: unknown
  error?: string
}

/** Monotonic correlation id source for ATV_CALL_ACTION round trips. */
let atvCallSeq = 0

export function registerAtvIpc(): void {
  ipcMain.on(IPC.ATV_OPEN, () => {
    log('atv_ipc: open requested')
    openAtvWindow('ipc')
  })

  // Palette cross-link: the ATV can summon the overlay glass (respects the
  // surface policy — an atv-only deployment has no glass to summon).
  ipcMain.on(IPC.ATV_SHOW_OVERLAY, () => {
    if (readSettings().surfacePolicy === 'atv-only') {
      log('atv_ipc: show-overlay refused by surface policy')
      return
    }
    showWindow('atv palette')
  })

  // Postcard export: renderer composes the PNG (canvas + stats footer);
  // main validates (PNG signature, size cap) and saves via the dialog.
  ipcMain.handle(IPC.ATV_EXPORT_IMAGE, async (_event, png: unknown) => {
    if (!(png instanceof ArrayBuffer) || png.byteLength === 0 || png.byteLength > 20 * 1024 * 1024) {
      log('atv_ipc: export-image rejected size', { bytes: png instanceof ArrayBuffer ? png.byteLength : -1 })
      return false
    }
    const bytes = Buffer.from(png)
    const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    if (!bytes.subarray(0, 8).equals(PNG_SIG)) {
      log('atv_ipc: export-image rejected signature')
      return false
    }
    const stamp = new Date().toISOString().slice(0, 10)
    const result = await dialog.showSaveDialog({
      defaultPath: join(app.getPath('desktop'), `ion-office-${stamp}.png`),
      filters: [{ name: 'PNG image', extensions: ['png'] }],
    })
    if (result.canceled || !result.filePath) return false
    await writeFile(result.filePath, bytes)
    log('atv_ipc: postcard exported', { path: result.filePath, bytes: bytes.length })
    return true
  })

  // Clip export: renderer records the canvas stream (MediaRecorder webm);
  // main validates (EBML signature, size cap) and saves via the dialog.
  ipcMain.handle(IPC.ATV_EXPORT_VIDEO, async (_event, webm: unknown) => {
    if (!(webm instanceof ArrayBuffer) || webm.byteLength === 0 || webm.byteLength > 100 * 1024 * 1024) {
      log('atv_ipc: export-video rejected size', { bytes: webm instanceof ArrayBuffer ? webm.byteLength : -1 })
      return false
    }
    const bytes = Buffer.from(webm)
    const EBML_SIG = Buffer.from([0x1a, 0x45, 0xdf, 0xa3])
    if (!bytes.subarray(0, 4).equals(EBML_SIG)) {
      log('atv_ipc: export-video rejected signature')
      return false
    }
    const stamp = new Date().toISOString().slice(0, 10)
    const result = await dialog.showSaveDialog({
      defaultPath: join(app.getPath('desktop'), `ion-office-clip-${stamp}.webm`),
      filters: [{ name: 'WebM video', extensions: ['webm'] }],
    })
    if (result.canceled || !result.filePath) return false
    await writeFile(result.filePath, bytes)
    log('atv_ipc: clip exported', { path: result.filePath, bytes: bytes.length })
    return true
  })

  // Campus view: live per-tab summaries derived from the all-tabs cache.
  ipcMain.handle(IPC.ATV_GET_ALL_STATUS, () => allAtvSummaries())

  // Owner-published tab-metadata sync. The overlay renderer publishes its
  // persisted tabs snapshot after every persist; main caches the latest and
  // pushes it to the ATV window. The ATV pulls the cache once on boot (view
  // readiness), then lives off the pushes.
  let tabsSyncSnapshot: unknown = null
  ipcMain.on(IPC.ATV_PUBLISH_TABS_SYNC, (_event, snapshot: unknown) => {
    if (snapshot == null || typeof snapshot !== 'object') return
    tabsSyncSnapshot = snapshot
    const win = state.atvWindow
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.ATV_TABS_SYNC, snapshot)
    }
  })
  ipcMain.handle(IPC.ATV_GET_TABS_SYNC, () => tabsSyncSnapshot)

  // Mirror-store action forwarding: the ATV window routes owner-durable store
  // mutations here; validation is derived from FORWARDED_ACTIONS (the single
  // classification source of truth), then the call is relayed to the overlay
  // renderer, which executes it on the owner store and replies with whatever
  // the action returned.
  //
  // Request/response rather than fire-and-forget because a mirror caller does
  // `const result = await store.retireWorktree(…)` and must get the owner's
  // real answer. The call is correlated by a main-minted callId and resolves on
  // the owner's ATV_ACTION_RESULT.
  //
  // Why main owns the correlation rather than the renderers doing it directly:
  // main is already the validation choke point for forwarded actions, and it is
  // the only party that knows whether an owner window exists. It also means a
  // dead or slow owner produces a resolved refusal instead of a mirror caller
  // hanging on a promise that can never settle.
  ipcMain.handle(IPC.ATV_CALL_ACTION, async (_event, action: unknown, args: unknown) => {
    if (!validForwardedAction(action, args)) {
      log('atv_ipc: call-action rejected', { action: String(action).slice(0, 64) })
      return { ok: false, error: 'action not permitted' }
    }
    const main = state.mainWindow
    if (!main || main.isDestroyed()) {
      log('atv_ipc: call-action dropped, no owner window', { action })
      return { ok: false, error: 'no owner window' }
    }
    const callId = `atv-call-${++atvCallSeq}`
    // Pin the owner's webContents id at dispatch time. The reply is accepted
    // only from THIS sender: ATV_ACTION_RESULT is an ipcMain.on listener, so
    // any renderer holding the preload bridge can send on it, and the callId is
    // a predictable counter. Without the check a non-owner window could settle
    // a pending call with a forged value — and the mirror would treat it as the
    // owner's real return, so a fabricated `{ ok: true }` would read as a
    // succeeded retire. Every other input on this channel is validated
    // (validForwardedAction gates action + args); sender identity is the last
    // one, and it is the only input that decides WHOSE answer this is.
    const ownerSenderId = main.webContents.id
    log('atv_ipc: calling action on owner', {
      action, call_id: callId, arg_count: (args as unknown[]).length,
    })

    return await new Promise<AtvActionReply>((resolve) => {
      // Set once the call concludes (reply or timeout) so a late reply is
      // logged rather than silently dropped — see the post-settle branch below.
      let settled = false
      // A single-shot listener keyed by callId AND sender. Removed on reply and
      // on timeout, so no path leaves a listener behind.
      const onReply = (event: Electron.IpcMainEvent, replyId: unknown, payload: unknown): void => {
        if (replyId !== callId) return
        if (event.sender.id !== ownerSenderId) {
          // A reply for a live callId from something other than the owner
          // window. Refuse it and keep waiting for the real one.
          log('atv_ipc: call-action reply rejected, sender is not the owner window', {
            action, call_id: callId, sender_id: event.sender.id, owner_id: ownerSenderId,
          })
          return
        }
        if (settled) {
          // Arrived after the deadline already resolved the caller. The value
          // cannot be delivered, but the near-miss must be visible: it means
          // ATV_CALL_TIMEOUT_MS is too tight for this action, which is
          // otherwise indistinguishable from a wedged owner in the log.
          log('atv_ipc: call-action reply arrived after timeout, dropped', {
            action, call_id: callId, timeout_ms: ATV_CALL_TIMEOUT_MS,
          })
          return
        }
        settled = true
        cleanup()
        log('atv_ipc: call-action replied', { action, call_id: callId })
        resolve({ ok: true, value: payload })
      }
      const timer = setTimeout(() => {
        settled = true
        // The listener stays registered briefly so a late reply can be logged
        // by the branch above; removeListener happens there or on teardown.
        clearTimeout(timer)
        // Not a silent drop: the owner may be mid-dialog or wedged, and the
        // mirror caller must be told rather than left pending forever.
        log('atv_ipc: call-action timed out waiting for owner', {
          action, call_id: callId, timeout_ms: ATV_CALL_TIMEOUT_MS,
        })
        resolve({ ok: false, error: 'owner did not reply' })
        // Bounded grace window for the late-reply log, then release the
        // listener. Without this the handler would leak one listener per
        // timed-out call for the life of the process.
        setTimeout(() => ipcMain.removeListener(IPC.ATV_ACTION_RESULT, onReply), ATV_LATE_REPLY_GRACE_MS)
      }, ATV_CALL_TIMEOUT_MS)
      function cleanup(): void {
        clearTimeout(timer)
        ipcMain.removeListener(IPC.ATV_ACTION_RESULT, onReply)
      }
      ipcMain.on(IPC.ATV_ACTION_RESULT, onReply)
      main!.webContents.send(IPC.ATV_EXEC_ACTION, action, args, callId)
    })
  })

  // State backfill for the ATV renderer: called on window open and consumed
  // together with atv:active-tab pushes on tab switches. `tabId` optional —
  // absent means "the current active tab".
  ipcMain.handle(IPC.ATV_GET_STATE, (_event, tabId?: string) => {
    if (tabId != null && (typeof tabId !== 'string' || !isValidSessionId(tabId))) {
      log('atv_ipc: get-state rejected invalid tabId', { tab_id: String(tabId).slice(0, 64) })
      return null
    }
    const target = tabId ?? state.atvActiveTabId
    if (!target) {
      log('atv_ipc: get-state with no active tab')
      return { activeTabId: null, activeProfileId: null, state: null }
    }
    return { activeTabId: target, activeProfileId: state.atvActiveProfileId, state: getAtvState(target) }
  })

  ipcMain.handle(IPC.ATV_GET_SETTINGS, () => {
    try {
      const raw = readSettings()
      const out: Record<string, unknown> = {}
      for (const key of ATV_SETTING_KEYS) {
        out[key] = raw[key] ?? (SETTINGS_DEFAULTS as Record<string, unknown>)[key]
      }
      // Derived, read-only: surface policy + beta gate for launcher visibility.
      out.atvEnabled = raw.surfacePolicy !== 'overlay-only' && raw.atvBeta === true
      return out
    } catch (err) {
      log('atv_ipc: get-settings failed', { error: String(err) })
      const out: Record<string, unknown> = {}
      for (const key of ATV_SETTING_KEYS) {
        out[key] = (SETTINGS_DEFAULTS as Record<string, unknown>)[key]
      }
      out.atvEnabled = false // safe: no readable settings = beta not enabled
      return out
    }
  })

  ipcMain.handle(IPC.ATV_SET_SETTING, (_event, key: unknown, value: unknown) => {
    if (typeof key !== 'string' || !ATV_SETTING_KEYS.has(key)) {
      log('atv_ipc: set-setting rejected key', { key: String(key).slice(0, 64) })
      return false
    }
    // Per-key shape validation.
    if (key === 'atvSeed') {
      if (typeof value !== 'string' || value.length > 256) return false
    } else if (key === 'atvPinned' || key === 'atvDockPresence' || key === 'atvAutoDrawer' || key === 'atvHeat' || key === 'atvBeacon' || key === 'atvSound') {
      if (typeof value !== 'boolean') return false
    } else if (key === 'atvZoom') {
      // 0 = fit-to-window mode; 1..6 = manual zoom.
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 6) return false
    } else if (key === 'atvLayout') {
      const v = value as { dockOpen?: unknown; dockWidth?: unknown; dockTab?: unknown } | null
      if (
        v == null ||
        typeof v !== 'object' ||
        typeof v.dockOpen !== 'boolean' ||
        typeof v.dockWidth !== 'number' ||
        v.dockWidth < 200 ||
        v.dockWidth > 1200 ||
        (v.dockTab !== 'conversation' && v.dockTab !== 'files')
      ) {
        return false
      }
    } else if (key === 'atvTheme') {
      if (typeof value !== 'string' || !/^[a-z0-9-]{1,64}$/.test(value)) return false
    }
    try {
      const settings = readSettings()
      settings[key] = value
      writeSettings(settings)
      // Dock presence applies live: toggling it while the ATV is open must
      // immediately grant/revoke the Dock icon, not wait for a reopen.
      if (key === 'atvDockPresence') applyAtvActivationPolicy(isAtvWindowOpen())
      log('atv_ipc: setting saved', { key })
      return true
    } catch (err) {
      log('atv_ipc: set-setting write failed', { key, error: String(err) })
      return false
    }
  })

  // ── Conversation picker ──

  // Tab list for the ATV toolbar picker (a pinned ATV can switch
  // conversations without opening the desktop overlay).
  ipcMain.handle(IPC.ATV_LIST_TABS, async () => {
    try {
      const snapshot = await getRemoteTabStates()
      // Desktop tab groups (custom/manual). Auto-grouped or ungrouped tabs
      // fall back to their directory basename as the category, mirroring the
      // desktop's automatic grouping.
      const settings = readSettings()
      const groups: Array<{ id: string; label: string; order: number }> = Array.isArray(settings.tabGroups)
        ? settings.tabGroups.map((g: any) => ({ id: String(g.id), label: String(g.label), order: Number(g.order) || 0 }))
        : []
      const groupById = new Map(groups.map((g) => [g.id, g]))
      const tabs = snapshot.tabs
        .filter((t) => !t.isTerminalOnly)
        .map((t) => {
          const dir = (t.workingDirectory || '').split('/').filter(Boolean).pop() ?? ''
          const group = t.groupId ? groupById.get(t.groupId) : undefined
          return {
            tabId: t.id,
            title: t.customTitle || t.title,
            status: t.status,
            directory: dir,
            extension: t.engineProfileId ?? '',
            group: group?.label ?? dir,
            groupOrder: group?.order ?? 1000,
          }
        })
      log('atv_ipc: listed tabs', { count: tabs.length, groups: groups.length })
      return tabs
    } catch (err) {
      log('atv_ipc: list-tabs failed', { error: String(err) })
      return []
    }
  })

  // Picker selection: forward to the main renderer's tab slice so the
  // desktop and the ATV stay on the same conversation (the resulting
  // active-tab notification re-targets the ATV).
  ipcMain.on(IPC.ATV_FOCUS_TAB, (_event, tabId: unknown) => {
    if (typeof tabId !== 'string' || !isValidSessionId(tabId)) {
      log('atv_ipc: focus-tab rejected', { tab_id: String(tabId).slice(0, 64) })
      return
    }
    log('atv_ipc: focus-tab', { tab_id: tabId })
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
      state.mainWindow.webContents.send(IPC.ATV_FOCUS_TAB, tabId)
    }
  })

  // Click-to-inspect: forward an agent selection to the main renderer,
  // which switches to the tab and opens that agent's dispatch detail. The
  // overlay auto-shows first — a click from a pinned ATV while the desktop
  // is hidden must surface the panel it opens, not populate a hidden window.
  ipcMain.on(IPC.ATV_FOCUS_AGENT, (_event, tabId: unknown, agentName: unknown) => {
    if (typeof tabId !== 'string' || !isValidSessionId(tabId)) return
    if (typeof agentName !== 'string' || agentName.length === 0 || agentName.length > 128) return
    log('atv_ipc: focus-agent', { tab_id: tabId, agent: agentName })
    showWindow('atv agent click')
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
      state.mainWindow.webContents.send(IPC.ATV_FOCUS_AGENT, tabId, agentName)
    }
  })

  // ── Theme packs ──

  ipcMain.handle(IPC.ATV_LIST_THEMES, () => listThemePacks())

  ipcMain.handle(IPC.ATV_READ_THEME_BUNDLE, (_event, packId: unknown) => {
    if (typeof packId !== 'string') return null
    return readPackBundle(packId)
  })

  ipcMain.handle(IPC.ATV_READ_THEME_ASSET, (_event, packId: unknown, relPath: unknown) => {
    if (typeof packId !== 'string' || typeof relPath !== 'string') return null
    const buf = readThemeAsset(packId, relPath)
    if (!buf) return null
    // Hand the renderer a standalone ArrayBuffer (structured-clone friendly).
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  })
}

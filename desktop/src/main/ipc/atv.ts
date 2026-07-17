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

  // Mirror-store action forwarding: the ATV window routes owner-durable
  // store mutations here; validation is derived from FORWARDED_ACTIONS (the
  // single classification source of truth), then the call is relayed to the
  // overlay renderer, which executes it on the owner store.
  ipcMain.on(IPC.ATV_FORWARD_ACTION, (_event, action: unknown, args: unknown) => {
    if (!validForwardedAction(action, args)) {
      log('atv_ipc: forward-action rejected', { action: String(action).slice(0, 64) })
      return
    }
    const main = state.mainWindow
    if (!main || main.isDestroyed()) {
      log('atv_ipc: forward-action dropped, no owner window', { action })
      return
    }
    log('atv_ipc: forwarding action to owner', { action, arg_count: (args as unknown[]).length })
    main.webContents.send(IPC.ATV_EXEC_ACTION, action, args)
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

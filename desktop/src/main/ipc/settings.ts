import { ipcMain } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'fs'
import { IPC } from '../../shared/types'
import { log as _log, debug as _debug } from '../logger'
import { state, engineBridge } from '../state'
import { atomicWriteFileSync } from '../utils/atomicWrite'
import { runTabUnifyMigration } from '../tab-migration-unify-runner'
import { runTabSplitMigration } from '../tab-migration-split-runner'
import {
  SETTINGS_DEFAULTS,
  SETTINGS_DIR,
  SETTINGS_FILE,
  SESSION_CHAINS_FILE,
  TABS_FILE,
  currentBackend,
  loadSessionChains,
  loadSessionLabels,
  readSettings,
  saveSessionChains,
  saveSessionLabels,
} from '../settings-store'
import { initRemoteTransport } from '../remote/transport-init'
import { persistAndBroadcastSettings } from '../settings-broadcast'
import { writeConfigAndRelaunch } from '../engine-restart'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}
function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug('main', msg, fields)
}

/**
 * Settings keys owned exclusively by the main process. Written by dedicated
 * main-side paths (pairing handler, revoke) — never legitimately changed by a
 * renderer SAVE_SETTINGS payload, whose full-object saves would otherwise
 * clobber them with a stale store snapshot. Exported for the regression test.
 */
export const MAIN_OWNED_SETTINGS_KEYS = ['pairedDevices'] as const

// ─── Tab persistence safety ───
//
// Minimum on-disk tab count before the sanity guard activates. Below this
// threshold the "50% drop" heuristic is too aggressive (closing 3 of 5 tabs
// legitimately triggers it). 10 is safe — at that scale a halving is a bug.
const TAB_GUARD_MIN_COUNT = 10

/**
 * Read the on-disk tab count from the primary tabs file. Returns 0 if the
 * file is missing or unreadable. The caller owns error handling.
 */
function readOnDiskTabCount(): number {
  try {
    if (existsSync(TABS_FILE)) {
      const data = JSON.parse(readFileSync(TABS_FILE, 'utf-8'))
      const tabs = data?.tabs
      return Array.isArray(tabs) ? tabs.length : 0
    }
  } catch {}
  return 0
}

export function registerSettingsIpc(): void {
  ipcMain.handle(IPC.LOAD_SETTINGS, () => {
    try {
      if (existsSync(SETTINGS_FILE)) {
        const settings: Record<string, any> = { ...SETTINGS_DEFAULTS, ...readSettings() }
        log('settings: loaded', { remote_enabled: settings.remoteEnabled, has_remote_transport: !!state.remoteTransport })
        if (settings.remoteEnabled && !state.remoteTransport) {
          initRemoteTransport(settings)
        }
        return settings
      }
    } catch (err) {
      log('settings: load failed', { error: String(err) })
    }
    return SETTINGS_DEFAULTS
  })

  ipcMain.handle(IPC.SAVE_SETTINGS, (_event, data: Record<string, unknown>) => {
    try {
      let prev: Record<string, unknown> = {}
      try { prev = readSettings() } catch {}

      // Main-owned keys: the disk value ALWAYS wins over the renderer's
      // payload. The renderer saves its whole settings object on every
      // preference change, and that object is a snapshot from whenever its
      // store last loaded/synced — a full-object save can silently revert a
      // key the main process wrote in the meantime. pairedDevices is written
      // by the pairing handler and revoke path (main process only); a stale
      // renderer save once reverted a fresh pairing on disk, orphaning the
      // just-paired iPhone ("unknown device" on every reconnect after the
      // next restart). Renderer mutations of these keys go through their own
      // dedicated IPC (e.g. revoke), never through SAVE_SETTINGS.
      for (const key of MAIN_OWNED_SETTINGS_KEYS) {
        const rendererValue = JSON.stringify(data[key] ?? null)
        const diskValue = JSON.stringify(prev[key] ?? null)
        if (rendererValue !== diskValue) {
          log('settings: ignoring stale renderer value for main-owned key', { key })
        }
        if (key in prev) data[key] = prev[key]
        else delete data[key]
      }

      // Single write+broadcast path shared with the iOS set_desktop_setting
      // wire command. The helper handles persistence atomically and emits a
      // desktop_settings_snapshot only when a projectable key changed (the
      // diff lives inside the helper now). Per engine-grounding §6 — both
      // edit surfaces funnel through one helper, exactly one log prefix
      // ([SETTINGS] persistAndBroadcast) to grep for in audit traces.
      persistAndBroadcastSettings(data, prev)

      const transportConfigChanged =
        data.remoteEnabled !== prev.remoteEnabled ||
        data.relayUrl !== prev.relayUrl ||
        data.relayApiKey !== prev.relayApiKey ||
        data.lanServerPort !== prev.lanServerPort
      if (transportConfigChanged && typeof data.remoteEnabled === 'boolean') {
        initRemoteTransport(data)
      }

      const relayConfigChanged = data.relayUrl !== prev.relayUrl || data.relayApiKey !== prev.relayApiKey
      if (relayConfigChanged && !transportConfigChanged && state.remoteTransport) {
        const relayUrl = (data.relayUrl as string) || ''
        const relayApiKey = (data.relayApiKey as string) || ''
        if (relayUrl) {
          state.remoteTransport.send({ type: 'desktop_relay_config', relayUrl, relayApiKey })
        }
      }
    } catch (err) {
      log('settings: save failed', { error: String(err) })
    }
  })

  ipcMain.handle(IPC.GET_BACKEND, () => currentBackend)

  ipcMain.handle(IPC.SWITCH_BACKEND, async (_event, newBackend: 'api' | 'cli') => {
    if (newBackend === currentBackend) return { ok: true }
    // Write the canonical engine value: "claude-code" (formerly "cli").
    const canonical = newBackend === 'api' ? 'api' : 'claude-code'
    await writeConfigAndRelaunch((cfg) => {
      cfg.backend = canonical
    })
  })

  ipcMain.handle(IPC.LOAD_TABS, () => {
    const PREV_FILE = TABS_FILE + '.prev'
    // One-time unify migration (backup → migrate → verify → restore-on-failure).
    // Idempotent: skips files already at the unified schemaVersion. Runs here —
    // the single load chokepoint — so migration always precedes the first read,
    // on both the primary file and the .prev recovery file. On verify failure
    // the migration leaves the legacy file untouched and the read-side
    // back-compat path below still loads it, so no data is lost.
    try {
      const primaryOutcome = runTabUnifyMigration(TABS_FILE)
      if (primaryOutcome.reason === 'success') {
        log('tabs: unify migration applied', { path: TABS_FILE, tab_count: primaryOutcome.tabCount, backup: primaryOutcome.backupPath })
      } else if (primaryOutcome.reason === 'verify-failed' || primaryOutcome.reason === 'error') {
        log('tabs: unify migration not applied', { path: TABS_FILE, reason: primaryOutcome.reason, error: primaryOutcome.errorMessage })
      }
      if (existsSync(PREV_FILE)) runTabUnifyMigration(PREV_FILE)
    } catch (err) {
      log('tabs: unify migration error', { error: (err as Error).message })
    }
    // Split migration: flatten multi-instance tabs into single-instance tabs.
    // Runs AFTER unify (requires schemaVersion >= 2). Idempotent at >= 3.
    // On verify failure the file is untouched; the renderer's defensive
    // single-instance restore handles any surviving multi-instance tabs.
    try {
      const splitOutcome = runTabSplitMigration(TABS_FILE)
      if (splitOutcome.reason === 'success') {
        log('tabs: split migration applied', { path: TABS_FILE, tabs_before: splitOutcome.tabsBefore, tabs_after: splitOutcome.tabsAfter, backup: splitOutcome.backupPath })
      } else if (splitOutcome.reason === 'verify-failed' || splitOutcome.reason === 'error') {
        log('tabs: split migration not applied', { path: TABS_FILE, reason: splitOutcome.reason, error: splitOutcome.errorMessage })
      }
      if (existsSync(PREV_FILE)) runTabSplitMigration(PREV_FILE)
    } catch (err) {
      log('tabs: split migration error', { error: (err as Error).message })
    }
    try {
      let primary: any = null
      let primaryCount = 0
      if (existsSync(TABS_FILE)) {
        primary = JSON.parse(readFileSync(TABS_FILE, 'utf-8'))
        primaryCount = Array.isArray(primary?.tabs) ? primary.tabs.length : 0
      }

      // Layer 3: startup recovery from .prev file.
      // If the primary file has suspiciously few tabs and a .prev file exists
      // with more, use the .prev file instead. This catches the scenario
      // where a crash or force-quit wrote a truncated tab state to disk.
      if (existsSync(PREV_FILE)) {
        try {
          const prev = JSON.parse(readFileSync(PREV_FILE, 'utf-8'))
          const prevCount = Array.isArray(prev?.tabs) ? prev.tabs.length : 0
          if (prevCount > primaryCount && primaryCount < TAB_GUARD_MIN_COUNT) {
            log('tabs: startup recovery, using .prev', { primary_count: primaryCount, prev_count: prevCount })
            return prev
          }
        } catch (err) {
          log('tabs: failed to read .prev during startup recovery', { error: String(err) })
        }
      }

      if (primary) {
        log('tabs: loaded', { count: primaryCount, path: TABS_FILE })
        return primary
      }
    } catch (err) {
      log('tabs: load failed', { error: String(err) })
    }
    return null
  })

  ipcMain.handle(IPC.SAVE_TABS, (_event, data: Record<string, unknown>) => {
    try {
      if (!existsSync(SETTINGS_DIR)) mkdirSync(SETTINGS_DIR, { recursive: true })

      const incomingCount = Array.isArray(data?.tabs) ? (data.tabs as unknown[]).length : 0

      // Layer 2: sanity guard on tab count regression.
      // If the on-disk file has >= TAB_GUARD_MIN_COUNT tabs and the incoming
      // count is less than 50% of the on-disk count, this is almost certainly
      // a bug (crash, renderer amnesia, etc.). Write the incoming data to a
      // .rejected file for diagnostics but do NOT overwrite the real file.
      const onDiskCount = readOnDiskTabCount()
      if (onDiskCount >= TAB_GUARD_MIN_COUNT && incomingCount < onDiskCount * 0.5) {
        const rejectedPath = TABS_FILE + '.rejected'
        log('tabs: guard refused save', { on_disk_count: onDiskCount, incoming_count: incomingCount, rejected_path: rejectedPath })
        atomicWriteFileSync(rejectedPath, JSON.stringify(data, null, 2), 0o644)
        return
      }

      // Layer 1: rolling backup. Rename the current file to .prev before
      // writing the new one. Best-effort — if the file doesn't exist yet
      // or the rename fails, we still proceed with the write.
      if (existsSync(TABS_FILE)) {
        try {
          renameSync(TABS_FILE, TABS_FILE + '.prev')
        } catch {
          // Non-fatal — the prev file may be locked or the FS may be slow.
        }
      }

      atomicWriteFileSync(TABS_FILE, JSON.stringify(data, null, 2), 0o644)

      // Layer 4: log every save with tab count for forensic tracing.
      debug('tabs: saved', { count: incomingCount, path: TABS_FILE })
    } catch (err) {
      log('tabs: save failed', { error: String(err) })
    }
  })

  ipcMain.handle(IPC.SAVE_SESSION_LABEL, (_event, { sessionId, customTitle }: { sessionId: string; customTitle: string | null }) => {
    const labels = loadSessionLabels()
    if (customTitle) {
      labels[sessionId] = customTitle
    } else {
      delete labels[sessionId]
    }
    saveSessionLabels(labels)
  })

  ipcMain.handle(IPC.GENERATE_TITLE, async (_event, text: string) => {
    try {
      return await engineBridge.generateTitle(text)
    } catch (err: any) {
      log('generate_title: failed', { error: err.message })
      return ''
    }
  })

  ipcMain.handle(IPC.LOAD_SESSION_LABELS, () => loadSessionLabels())

  ipcMain.handle(IPC.LOAD_SESSION_CHAINS, () => loadSessionChains())

  ipcMain.handle(IPC.SAVE_SESSION_CHAINS, (_event, data: { chains: Record<string, string[]>; reverse: Record<string, string> }) => {
    saveSessionChains(data)
  })
}

// silence unused warning when SESSION_CHAINS_FILE not directly referenced
void SESSION_CHAINS_FILE

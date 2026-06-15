import { app, BrowserWindow, ipcMain } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'fs'
import { IPC } from '../../shared/types'
import { log as _log } from '../logger'
import { state, engineBridge } from '../state'
import { atomicWriteFileSync } from '../utils/atomicWrite'
import { runTabUnifyMigration } from '../tab-migration-unify-runner'
import {
  SETTINGS_DEFAULTS,
  SETTINGS_DIR,
  SETTINGS_FILE,
  SESSION_CHAINS_FILE,
  TABS_FILE,
  currentBackend,
  loadSessionChains,
  loadSessionLabels,
  readEngineConfig,
  readSettings,
  saveSessionChains,
  saveSessionLabels,
  writeEngineConfig,
} from '../settings-store'
import { initRemoteTransport } from '../remote/transport-init'
import { persistAndBroadcastSettings } from '../settings-broadcast'

function log(msg: string): void {
  _log('main', msg)
}

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
        log(`[Settings] loaded: remoteEnabled=${settings.remoteEnabled} remoteTransport=${!!state.remoteTransport}`)
        if (settings.remoteEnabled && !state.remoteTransport) {
          initRemoteTransport(settings)
        }
        return settings
      }
    } catch (err) {
      log(`Failed to load settings: ${err}`)
    }
    return SETTINGS_DEFAULTS
  })

  ipcMain.handle(IPC.SAVE_SETTINGS, (_event, data: Record<string, unknown>) => {
    try {
      let prev: Record<string, unknown> = {}
      try { prev = readSettings() } catch {}

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
          state.remoteTransport.send({ type: 'relay_config', relayUrl, relayApiKey })
        }
      }
    } catch (err) {
      log(`Failed to save settings: ${err}`)
    }
  })

  ipcMain.handle(IPC.GET_BACKEND, () => currentBackend)

  ipcMain.handle(IPC.SWITCH_BACKEND, async (_event, newBackend: 'api' | 'cli') => {
    if (newBackend === currentBackend) return { ok: true }

    for (const win of BrowserWindow.getAllWindows()) {
      try {
        await win.webContents.executeJavaScript(
          'window.__ionForceFlushTabs && window.__ionForceFlushTabs()',
        )
      } catch {}
    }

    const cfg = readEngineConfig()
    cfg.backend = newBackend
    writeEngineConfig(cfg)

    await engineBridge.shutdownAndWait()

    state.forceQuit = true
    app.relaunch()
    app.quit()
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
        log(`[tabs] unify migration applied to ${TABS_FILE} (${primaryOutcome.tabCount} tabs, backup ${primaryOutcome.backupPath})`)
      } else if (primaryOutcome.reason === 'verify-failed' || primaryOutcome.reason === 'error') {
        log(`[tabs] unify migration NOT applied to ${TABS_FILE} (${primaryOutcome.reason}: ${primaryOutcome.errorMessage}) — loading legacy via back-compat`)
      }
      if (existsSync(PREV_FILE)) runTabUnifyMigration(PREV_FILE)
    } catch (err) {
      log(`[tabs] unify migration unexpected error: ${(err as Error).message} — loading legacy`)
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
            log(`[tabs] Startup recovery: primary has ${primaryCount} tabs but .prev has ${prevCount} — using .prev`)
            return prev
          }
        } catch (err) {
          log(`[tabs] Failed to read .prev file during startup recovery: ${err}`)
        }
      }

      if (primary) {
        log(`[tabs] Loaded ${primaryCount} tabs from ${TABS_FILE}`)
        return primary
      }
    } catch (err) {
      log(`Failed to load tabs: ${err}`)
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
        log(`[tabs] GUARD: refusing save — on-disk has ${onDiskCount} tabs but incoming has ${incomingCount}. Writing to ${rejectedPath} instead.`)
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
      log(`[tabs] Saved ${incomingCount} tabs to ${TABS_FILE}`)
    } catch (err) {
      log(`Failed to save tabs: ${err}`)
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
      log(`Failed to generate title: ${err.message}`)
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

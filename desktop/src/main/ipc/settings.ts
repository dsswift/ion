import { app, BrowserWindow, ipcMain } from 'electron'
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { IPC } from '../../shared/types'
import { log as _log } from '../logger'
import { state, engineBridge } from '../state'
import { atomicWriteFileSync } from '../utils/atomicWrite'
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
  writeSettings,
} from '../settings-store'
import { initRemoteTransport } from '../remote/transport-init'

function log(msg: string): void {
  _log('main', msg)
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

      writeSettings(data as Record<string, any>)

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
    try {
      if (existsSync(TABS_FILE)) {
        return JSON.parse(readFileSync(TABS_FILE, 'utf-8'))
      }
    } catch (err) {
      log(`Failed to load tabs: ${err}`)
    }
    return null
  })

  ipcMain.handle(IPC.SAVE_TABS, (_event, data: Record<string, unknown>) => {
    try {
      if (!existsSync(SETTINGS_DIR)) mkdirSync(SETTINGS_DIR, { recursive: true })
      atomicWriteFileSync(TABS_FILE, JSON.stringify(data, null, 2), 0o644)
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

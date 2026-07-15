import { app, BrowserWindow } from 'electron'
import { log as _log } from './logger'
import { state, engineBridge } from './state'
import { readEngineConfig, writeEngineConfig } from './settings-store'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('engine-restart', msg, fields)
}

/**
 * Flush pending tab state, mutate the engine config, and relaunch the app so
 * the engine daemon re-reads the new config. Shared by the backend-switch and
 * per-provider-backend IPC handlers — both change how the engine routes runs,
 * which the launchd daemon only picks up on a fresh start.
 *
 * The tab flush mirrors SWITCH_BACKEND: the desktop-local backend union keys
 * the on-disk tab file names, so pending tab edits must be persisted before the
 * relaunch reads them back under the (possibly new) backend.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- engine.json is an untyped config bag, matching readEngineConfig's Record<string, any>.
export async function writeConfigAndRelaunch(mutate: (cfg: Record<string, any>) => void): Promise<void> {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      await win.webContents.executeJavaScript('window.__ionForceFlushTabs && window.__ionForceFlushTabs()')
    } catch {
      // A window without the flush hook (e.g. mid-teardown) is fine to skip.
    }
  }

  const cfg = readEngineConfig()
  mutate(cfg)
  writeEngineConfig(cfg)
  log('config written, relaunching engine')

  await engineBridge.shutdownAndWait()
  state.forceQuit = true
  app.relaunch()
  app.quit()
}

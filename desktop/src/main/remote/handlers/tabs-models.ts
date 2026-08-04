import { log as _log } from '../../logger'
import { state } from '../../state'
import type { RemoteCommand } from '../protocol'

/**
 * tabs-models — the three model-selection command handlers from iOS.
 *
 * Extracted from handlers/tabs.ts to keep both files under the 600-line cap.
 * The seam is cohesive: all three set a MODEL preference (per-tab override,
 * user default, engine default) by driving a renderer store through the
 * contextBridge, and they share nothing with the tab lifecycle / history
 * handlers that remain in tabs.ts.
 */

const TAG = 'Remote'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }

/** Escape a value for safe interpolation into an executeJavaScript string. */
function esc(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

export async function handleSetTabModel(cmd: Extract<RemoteCommand, { type: 'desktop_set_tab_model' }>): Promise<void> {
  try {
    const escapedTab = esc(cmd.tabId)
    const escapedModel = esc(cmd.model)
    await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        var store = window.__Ion_SESSION_STORE__;
        if (!store) return;
        store.getState().setTabModel('${escapedTab}', '${escapedModel}');
      })()
    `)
  } catch (err) {
    log('set_tab_model error: ' + (err as Error).message)
  }
}

export async function handleSetPreferredModel(cmd: Extract<RemoteCommand, { type: 'desktop_set_preferred_model' }>): Promise<void> {
  try {
    const escapedModel = esc(cmd.model)
    await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        var prefs = window.__Ion_PREFS_STORE__;
        if (!prefs) return;
        prefs.getState().setPreferredModel('${escapedModel}');
      })()
    `)
  } catch (err) {
    log('set_preferred_model error: ' + (err as Error).message)
  }
}

export async function handleSetEngineDefaultModel(cmd: Extract<RemoteCommand, { type: 'desktop_set_engine_default_model' }>): Promise<void> {
  try {
    const escapedModel = esc(cmd.model)
    await state.mainWindow?.webContents.executeJavaScript(`
      (function() {
        var prefs = window.__Ion_PREFS_STORE__;
        if (!prefs) return;
        prefs.getState().setEngineDefaultModel('${escapedModel}');
      })()
    `)
  } catch (err) {
    log('set_engine_default_model error: ' + (err as Error).message)
  }
}

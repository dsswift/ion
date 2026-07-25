/**
 * IPC surface for custom color theme packs.
 *
 * The renderer pulls the current custom-theme set at boot
 * (THEMES_LIST_CUSTOM) and receives live updates via the
 * `ion:themes-changed` broadcast whenever the on-disk pack set changes
 * (fs watcher or sync-time rescan). Payloads carry resolved desktop
 * components with inline asset data URLs — no renderer disk access.
 */
import { ipcMain } from 'electron'
import { IPC } from '../../shared/types'
import { log as _log } from '../logger'
import { broadcast } from '../broadcast'
import { broadcastDesktopSettingsSnapshot } from '../settings-broadcast'
import { state } from '../state'
import { buildThemeManifest, getRendererThemes, onThemePacksChanged, startThemePackWatcher } from '../theme-packs'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('themes', msg, fields)
}

export function registerThemesIpc(): void {
  ipcMain.handle(IPC.THEMES_LIST_CUSTOM, () => {
    const list = getRendererThemes()
    log('themes_ipc: listed custom themes', { count: list.length })
    return list
  })

  // Push the refreshed set to both windows whenever the pack set changes.
  // Routed through broadcast() so the ATV mirror window converges too. The
  // settings snapshot is re-broadcast as well: the selectedTheme schema
  // choices embed the live pack set, so paired iOS pickers must refresh.
  onThemePacksChanged(() => {
    const list = getRendererThemes()
    log('themes_ipc: pack set changed; pushing to renderers', { count: list.length })
    broadcast('ion:themes-changed', list)
    broadcastDesktopSettingsSnapshot('theme_packs_changed')
    // Paired iOS devices get the refreshed iOS components immediately
    // (replace-wholesale snapshot semantics; no reconnect required).
    if (state.remoteTransport) {
      const manifest = buildThemeManifest()
      log('themes_ipc: broadcasting theme manifest', { theme_count: manifest.themes.length, hash: manifest.hash })
      state.remoteTransport.send({ type: 'desktop_theme_manifest', ...manifest })
    }
  })

  startThemePackWatcher()
}

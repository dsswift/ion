/**
 * Custom color theme packs, wired for every Studio client.
 *
 * The renderer pulls the current set once at boot (`themes.list`) and
 * receives live updates on `ion:themes-changed` whenever the on-disk pack
 * set changes (fs watcher or sync-time rescan). Payloads carry resolved
 * desktop components with inline asset data URLs, so a client never reads
 * the disk. The desktop settings snapshot is re-broadcast on the same edge
 * because the `selectedTheme` schema's choices embed the live pack set.
 *
 * Paired iOS devices get the refreshed iOS components on the same edge
 * (replace-wholesale manifest semantics; no reconnect required).
 *
 * This wiring lived in the desktop's `ipc/themes.ts`, so a browser client
 * booted with only the built-in themes and never learned that a pack had
 * been added.
 */
import { broadcast } from './broadcast'
import { log as _log } from './logger'
import { broadcastDesktopSettingsSnapshot } from './settings-broadcast'
import { buildThemeManifest, getRendererThemes, onThemePacksChanged, rescanThemePacks, startThemePackWatcher } from './theme-packs'
import { onEnterprisePolicyChange, settledEnterprisePolicy } from './enterprise-policy-publish'
import { sendRemoteEvent, remoteClientsPresent } from './thin-view/remote-out'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('themes', msg, fields)
}

/** Subscribe pack-set changes to the wire and start watching the pack roots. Returns the change unsubscribe. */
export function wireThemePackEvents(): () => void {
  const off = onThemePacksChanged(() => {
    const list = getRendererThemes()
    log('pack set changed; pushing to clients', { count: list.length })
    broadcast('ion:themes-changed', list)
    broadcastDesktopSettingsSnapshot('theme_packs_changed')
    if (remoteClientsPresent()) {
      const manifest = buildThemeManifest()
      log('broadcasting theme manifest to paired devices', { theme_count: manifest.themes.length, hash: manifest.hash })
      sendRemoteEvent({ type: 'desktop_theme_manifest', ...manifest })
    }
  })
  startThemePackWatcher()
  log('theme pack watcher started')
  // The account's asset scopes come from the enterprise policy, which is
  // read after boot and can change on an engine reconnect. Either moves the
  // set of roots, so rescan and re-arm the watcher.
  const rescanForPolicy = (reason: string): void => {
    const changed = rescanThemePacks()
    startThemePackWatcher()
    log('theme pack roots re-read for enterprise policy', { reason, changed })
  }
  const offPolicy = onEnterprisePolicyChange(() => rescanForPolicy('policy_changed'))
  let wired = true
  void settledEnterprisePolicy().then(() => {
    if (wired) rescanForPolicy('policy_settled')
  })
  return () => {
    wired = false
    off()
    offPolicy()
  }
}

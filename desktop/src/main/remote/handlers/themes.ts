/**
 * Wire handlers for theme-pack sync (desktop↔iOS).
 *
 * The manifest of iOS theme components rides sendSync (tabs-sync.ts);
 * this module owns the lazy asset fetch: iOS requests one asset by
 * (themeId, slot) after a manifest whose sha256 misses its cache, and
 * the desktop answers with the base64 data URL. Same shape as the
 * desktop_fs_read_image → desktop_fs_image_content pair.
 */
import { log as _log } from '../../logger'
import { state } from '../../state'
import { readIosThemeAsset } from '../../theme-packs'
import type { RemoteCommand } from '../protocol'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('themes', msg, fields)
}

export function handleRequestThemeAsset(
  cmd: Extract<RemoteCommand, { type: 'desktop_request_theme_asset' }>,
  deviceId: string,
): void {
  const { themeId, slot } = cmd
  if (slot !== 'background' && slot !== 'logo') {
    log('theme asset request rejected: bad slot', { pack_id: String(themeId), slot: String(slot), device_id: deviceId })
    state.remoteTransport?.sendToDevice(deviceId, {
      type: 'desktop_theme_asset_content', themeId: String(themeId), slot: 'background', ok: false,
    })
    return
  }
  const asset = readIosThemeAsset(themeId, slot)
  if (!asset) {
    log('theme asset request failed', { pack_id: themeId, slot, device_id: deviceId })
    state.remoteTransport?.sendToDevice(deviceId, {
      type: 'desktop_theme_asset_content', themeId, slot, ok: false,
    })
    return
  }
  log('theme asset served', { pack_id: themeId, slot, sha256: asset.sha256, device_id: deviceId })
  state.remoteTransport?.sendToDevice(deviceId, {
    type: 'desktop_theme_asset_content',
    themeId,
    slot,
    ok: true,
    sha256: asset.sha256,
    dataUrl: asset.dataUrl,
  })
}

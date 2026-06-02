/**
 * Wire handler for `set_desktop_setting` commands from iOS.
 *
 * iOS sends `set_desktop_setting { key, value }` when the user toggles a
 * row in the Settings tab. This handler:
 *
 *   1. Validates the key against the allowlist in
 *      `desktop/src/main/projectable-settings.ts`. Unknown keys are
 *      silently rejected (logged + no write).
 *   2. Validates the value's runtime type matches the declared type.
 *      Wrong-type values are silently rejected (logged + no write).
 *   3. Reads the current settings, merges the change, and persists +
 *      broadcasts through the single helper
 *      `persistAndBroadcastSettings` in `settings-broadcast.ts`. That
 *      helper is the canonical write+broadcast path shared with the
 *      renderer SAVE_SETTINGS handler — engine-grounding §6's "exactly
 *      one persistence + broadcast path" guarantee is enforced by
 *      routing both edit surfaces through the same function.
 *
 * Rejection is silent because iOS already has the previous value cached
 * — failing to write produces no observable client effect, and a
 * malformed write is a programming error iOS should fix rather than
 * something the user needs to be told about.
 */

import { log as _log } from '../../logger'
import { readSettings } from '../../settings-store'
import {
  isProjectableKey,
  validateSettingValue,
} from '../../projectable-settings'
import { persistAndBroadcastSettings } from '../../settings-broadcast'
import { broadcast } from '../../broadcast'
import type { RemoteCommand } from '../protocol'

function log(msg: string): void {
  _log('main', msg)
}

/** Wire-level handler for the `set_desktop_setting` command from iOS. */
export async function handleSetDesktopSetting(
  cmd: Extract<RemoteCommand, { type: 'set_desktop_setting' }>,
  deviceId: string,
): Promise<void> {
  const tag = `device=${deviceId.slice(0, 8)} key=${cmd.key} valueType=${typeof cmd.value}`
  if (!isProjectableKey(cmd.key)) {
    // Unknown key — log loudly because this means iOS has drifted from
    // the desktop's allowlist (the iOS UI shouldn't ever send a key
    // that wasn't in the most recent snapshot). Refusing the write is
    // safer than guessing what to do with a name we don't recognize.
    log(`SETTINGS-CMD: rejecting ${tag} — unknown key`)
    return
  }
  const validationError = validateSettingValue(cmd.key, cmd.value)
  if (validationError) {
    log(`SETTINGS-CMD: rejecting ${tag} — ${validationError}`)
    return
  }

  // Merge-and-persist. Read fresh so we don't clobber a setting that
  // changed between iOS issuing the command and the handler running.
  // (Highly unlikely, but the read is cheap and the safety is real.)
  const current = readSettings()
  const next = { ...current, [cmd.key]: cmd.value }
  try {
    persistAndBroadcastSettings(next, current)
    // Notify the renderer so its Zustand store picks up the change.
    // Without this, iOS-originated writes only land on disk — the
    // renderer keeps the stale in-memory value until the next restart.
    broadcast('ion:settings-changed', cmd.key, cmd.value)
    log(`SETTINGS-CMD: applied ${tag}`)
  } catch (err) {
    log(`SETTINGS-CMD: write failed ${tag} err=${err}`)
    return
  }
}

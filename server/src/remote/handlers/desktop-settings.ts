/**
 * A write to a projectable setting from a client that renders the projected
 * Settings list (the phone): the `settings.setProjectable` Studio action.
 * `applyProjectableSetting`:
 *
 *   1. Validates the key against the projectable allowlist. Unknown keys are
 *      refused.
 *   2. Validates the value's runtime type against the declared type.
 *   3. Routes the write by the key's scope in the settings registry:
 *        - an Environment setting goes to the server's settings document,
 *          through `persistAndBroadcastSettings`, and needs the `admin` scope;
 *        - anything else goes to the CALLER's overlay.
 *      This is the same routing `settings.save` applies, so the phone and
 *      Studio write one key to one place. They used not to: the phone wrote
 *      every key to the shared document while Studio wrote personal ones to
 *      the overlay, and the overlay shadows the shared document on every
 *      read, so a change made on the phone silently did nothing.
 *
 * A refusal is a value returned to the caller, which keeps showing what it
 * had and can say why.
 */

import { log as _log, warn as _warn } from '../../logger'
import { readSettings } from '../../persistence/settings-store'
import {
  isProjectableKey,
  validateSettingValue,
} from '../../projectable-settings'
import { broadcastDesktopSettingsSnapshot, persistAndBroadcastSettings } from '../../settings-broadcast'
import { writeSettingsForSubject } from '../../persistence/user-settings-store'
import { settingScope } from '@ion/shared/settings-registry'
import { scopeSatisfies } from '@ion/shared/studio-wire/action-scopes'
import type { Scope } from '@ion/shared/studio-wire/types'
import { broadcast } from '../../broadcast'
import type { ConnectionTransport } from '../../protocol/connection'
import { currentEnterprisePolicy } from '../../enterprise-policy-source'
import { sealRefusalError, settingsSealRefusal } from '../../protocol/settings-seal'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('main', msg, fields)
}

/** Why a projectable-setting write was not applied. `admin_required` is a missing scope, `wrong_scope` a key the client keeps itself; the rest are the caller's error. */
export type ProjectableSettingRefusal = 'unknown_key' | 'invalid_value' | 'admin_required' | 'wrong_scope' | 'write_failed' | 'settings_sealed' | 'settings_hidden'

export type ProjectableSettingResult = { ok: true } | { ok: false; code: ProjectableSettingRefusal; message: string; keys?: string[]; class?: 'sealed' }

/** Who is writing: the overlay written is theirs, and `scopes` decides whether they may change the Environment. */
export interface ProjectableSettingCaller {
  subject: string
  scopes: readonly Scope[]
  /** Labels the log lines only. */
  label: string
  /** How the connection arrived; decides whether a hidden group applies to it. Absent: not local. */
  transport?: ConnectionTransport
}

export function applyProjectableSetting(key: string, value: unknown, caller: ProjectableSettingCaller): ProjectableSettingResult {
  const scope = settingScope(key)
  const tag = `${caller.label} key=${key} scope=${scope ?? 'unknown'} valueType=${typeof value}`
  if (!isProjectableKey(key)) {
    // A client should never send a key that was not in the snapshot it was
    // given, so this means it has drifted from the allowlist. Refusing is
    // safer than guessing what to do with a name we do not recognize.
    log('settings_cmd: rejecting unknown key', { tag })
    return { ok: false, code: 'unknown_key', message: `${key} is not a projectable setting` }
  }
  const validationError = validateSettingValue(key, value)
  if (validationError) {
    log('settings_cmd: rejecting validation error', { tag, error: validationError })
    return { ok: false, code: 'invalid_value', message: validationError }
  }
  if (scope === 'personal' || scope === 'device') {
    // The client's own. It is listed so a thin client knows the setting
    // exists and what its default is, but the value is kept on that client.
    warn('settings_cmd: refused, the key belongs to the client', { tag, subject: caller.subject })
    return { ok: false, code: 'wrong_scope', message: `${key} is kept on the client, not on a server` }
  }

  const sealRefusal = settingsSealRefusal({ transport: caller.transport ?? 'relay' }, currentEnterprisePolicy(), [key])
  if (sealRefusal) {
    warn('settings_cmd: refused by enterprise policy', { tag, subject: caller.subject, code: sealRefusal.code })
    return { ok: false, ...sealRefusalError(sealRefusal), code: sealRefusal.code }
  }
  try {
    if (scope === 'environment') {
      if (!scopeSatisfies(caller.scopes, 'admin')) {
        warn('settings_cmd: environment setting refused, caller lacks admin', { tag, subject: caller.subject, granted_scopes: [...caller.scopes] })
        return { ok: false, code: 'admin_required', message: `changing ${key} requires the admin scope on this server` }
      }
      // Read fresh so a setting that changed between the client issuing the
      // write and this running is not clobbered.
      const current = readSettings()
      persistAndBroadcastSettings({ ...current, [key]: value }, current)
      log('settings_cmd: environment setting applied', { tag, subject: caller.subject })
    } else {
      if (!caller.subject) {
        warn('settings_cmd: refused, caller has no subject to store against', { tag })
        return { ok: false, code: 'write_failed', message: 'no identity to store settings against' }
      }
      writeSettingsForSubject(caller.subject, { [key]: value })
      // The overlay write reaches no broadcast of its own: tell this person's
      // other clients, and refresh the projected list the phone renders.
      broadcastDesktopSettingsSnapshot(`overlay:${key}`)
      log('settings_cmd: overlay setting applied', { tag, subject: caller.subject })
    }
    // Tell Studio clients so their stores pick up the change; without this
    // the write only lands on disk. An Environment setting reaches everyone.
    // An overlay setting reaches its owner's connections only (the third
    // argument routes it, `protocol/events.ts`).
    if (scope === 'environment') broadcast('ion:settings-changed', key, value)
    else broadcast('ion:settings-changed', key, value, caller.subject)
    return { ok: true }
  } catch (err) {
    warn('settings_cmd: write failed', { tag, error: String(err) })
    return { ok: false, code: 'write_failed', message: String(err) }
  }
}

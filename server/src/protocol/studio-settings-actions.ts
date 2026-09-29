/**
 * `studio.getSettings` / `studio.setSetting` — the Studio surface's own
 * per-person UI state on the wire.
 *
 * This pair is what persists the left sidebar's open/closed state and each
 * conversation's surface panel record (visible, width, which tabs, which is
 * active). It existed only as Electron IPC, so a browser Studio client
 * refused both: the sidebar and the surface panel reset to defaults on every
 * reload, and nothing was written anywhere to explain it.
 *
 * Storage is the caller's OWN overlay (`user-settings-store`), keyed by the
 * connection's resolved principal — never by anything in the payload. That
 * is deliberate and differs from the Electron adapter, which writes the
 * machine settings file: one desktop is one person, but one server is many,
 * and two people sharing an Environment must not fight over one sidebar
 * state. The allowlist and the per-key shape checks are shared with the IPC
 * adapter (`persistence/studio-settings-keys.ts`), so only the STORE differs,
 * never what is accepted.
 *
 * ── Scope ───────────────────────────────────────────────────────────────
 * `conversations:read` on both, matching `settings.*`: this is the caller's
 * own panel state and changes nothing another client can observe.
 */
import type { Scope } from '@ion/shared/studio-wire/types'
import { settingScope } from '@ion/shared/settings-registry'
import { projectStudioSettings, validateStudioSetting } from '../persistence/studio-settings-keys'
import { readSettingsForSubject, writeSettingsForSubject } from '../persistence/user-settings-store'
import { log as _log, warn as _warn } from '../logger'
import type { Connection } from './connection'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('studio-settings-actions', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('studio-settings-actions', msg, fields)
}

export interface StudioSettingsActionSpec {
  requiredScope: Scope
  handler: (conn: Connection, args: unknown[]) => Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }>
}

export const STUDIO_SETTINGS_ACTIONS: Record<string, StudioSettingsActionSpec> = {
  'studio.getSettings': {
    requiredScope: 'conversations:read',
    handler: async (conn) => {
      try {
        return { ok: true, value: projectStudioSettings(readSettingsForSubject(conn.principal?.subject ?? '')) }
      } catch (err) {
        warn('studio get-settings failed', { connection_id: conn.id, error: String(err) })
        // Defaults rather than a failure: a client with no readable overlay
        // must still paint, and `projectStudioSettings` fills every key.
        return { ok: true, value: projectStudioSettings({}) }
      }
    },
  },
  'studio.setSetting': {
    requiredScope: 'conversations:read',
    handler: async (conn, args) => {
      const [key, value] = args
      if (typeof key === 'string' && settingScope(key) === 'environment') {
        // One value for the whole server. This funnel writes only the
        // caller's overlay, where the server never reads it, so accepting it
        // would report success for a value that changes nothing.
        warn('studio set-setting refused: environment key', { connection_id: conn.id, key })
        return { ok: false, error: { code: 'wrong_scope', message: `${key} is a server setting; change it through settings.save` } }
      }
      if (!validateStudioSetting(key, value)) {
        log('studio set-setting rejected', { connection_id: conn.id, key: String(key).slice(0, 64) })
        return { ok: true, value: false }
      }
      const subject = conn.principal?.subject ?? ''
      if (!subject) {
        warn('studio set-setting refused: connection has no principal subject', { connection_id: conn.id, key })
        return { ok: false, error: { code: 'studio_setting_failed', message: 'no identity to store settings against' } }
      }
      try {
        writeSettingsForSubject(subject, { [key]: value })
        log('studio setting saved', { connection_id: conn.id, key })
        return { ok: true, value: true }
      } catch (err) {
        warn('studio set-setting write failed', { connection_id: conn.id, key, error: String(err) })
        return { ok: false, error: { code: 'studio_setting_failed', message: String(err) } }
      }
    },
  },
}

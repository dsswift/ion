/**
 * `settings.*` `studio_action`s — per-identity Studio preferences.
 *
 * The renderer's preference funnel (`preferences-persist.ts`) called
 * `window.ion?.saveSettings(...)` directly. In a browser `window.ion` is
 * undefined, so the optional chain evaluated to `undefined` and the write
 * vanished with no error, no warning, and nothing in any log — the operator
 * changed a setting, reloaded, and it came back. The read side did the
 * same thing and silently fell back to defaults.
 *
 * Both halves are actions now. The subject comes from the CONNECTION's
 * resolved principal, never from the payload: a client may only ever read
 * and write its own overlay, and cannot name someone else's.
 *
 * ── Ownership ───────────────────────────────────────────────────────────
 * A client saves its whole settings document, and that document carries
 * three kinds of key (`@ion/shared/settings-classification`):
 *
 *   - SERVER-OWNED (`pairedDevices`, the relay OIDC keys): written only by
 *     the pairing handler, revoke and the relay probe. Dropped from every
 *     patch; the disk value always wins, so a stale client snapshot can never
 *     revert a fresh pairing.
 *   - ENVIRONMENT-OWNED (one value for the whole server: the device
 *     transport, auto-settle, conversation recovery, projects, and the rest
 *     of the registry's `environment` scope): persisted to the Environment's
 *     `settings.json`, and only for a connection holding the `admin` scope,
 *     from any transport. A patch that would CHANGE one without `admin` is
 *     refused `settings_locked` in full, so nothing half-applies. A patch
 *     that merely repeats the value already on disk changes nothing and is
 *     not a refusal.
 *   - everything else goes to the caller's own overlay.
 *
 * Before this split the transport toggle landed in the overlay, where the
 * transport never looked, so "enable remote" from the Remote category did
 * nothing on a client that saved through the wire.
 *
 * ── Scope ───────────────────────────────────────────────────────────────
 * Both take `conversations:read`, the lowest authenticated bar, because the
 * caller's own overlay is the caller's own. The environment keys inside a
 * patch are gated on `admin` in the handler. That gate used to be the
 * connection's transport, which locked a server's own operator out of it
 * from every device but the one it ran on, and said nothing about who the
 * caller was.
 */
import type { Scope } from '@ion/shared/studio-wire/types'
import { scopeSatisfies } from '@ion/shared/studio-wire/action-scopes'
import { sanitizePersonalPreferences, settingScope } from '@ion/shared/settings-registry'
import { isEnvironmentOwnedSettingsKey, isServerOwnedSettingsKey } from '@ion/shared/settings-classification'
import { readSettingsForSubject, writeSettingsForSubject } from '../persistence/user-settings-store'
import { readSettings } from '../persistence/settings-store'
import { withoutSecrets } from '../utils/secretStore'
import { broadcastDesktopSettingsSnapshot, persistAndBroadcastSettings } from '../settings-broadcast'
import { isProjectableKey } from '../projectable-settings'
import { broadcast } from '../broadcast'
import { useSessionStore } from '../store/sessionStore'
import { tabsAutoSettleWouldSettle } from '../store/auto-settle-sweep'
import { log as _log, warn as _warn } from '../logger'
import type { Connection } from './connection'
import { currentEnterprisePolicy } from '../enterprise-policy-source'
import { settingsSealRefusal } from './settings-seal'
import { AI_ASSIST_WORKFLOWS } from '@ion/shared/ai-assist-workflows'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('settings-actions', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('settings-actions', msg, fields)
}

/** Split one patch into what the environment document takes and what the caller's overlay takes. */
export function partitionSettingsPatch(patch: Record<string, unknown>): {
  environment: Record<string, unknown>
  personal: Record<string, unknown>
  droppedServerOwned: string[]
  /** Personal and Device keys. They live on the client; a server stores none. */
  clientOwned: string[]
} {
  const environment: Record<string, unknown> = {}
  const personal: Record<string, unknown> = {}
  const droppedServerOwned: string[] = []
  const clientOwned: string[] = []
  for (const [key, value] of Object.entries(patch)) {
    const scope = settingScope(key)
    if (isServerOwnedSettingsKey(key)) droppedServerOwned.push(key)
    else if (isEnvironmentOwnedSettingsKey(key)) environment[key] = value
    else if (scope === 'personal' || scope === 'device') clientOwned.push(key)
    else personal[key] = value
  }
  return { environment, personal, droppedServerOwned, clientOwned }
}

export type SettingsActionOutcome =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string } }

export interface SettingsActionSpec {
  requiredScope: Scope
  handler: (conn: Connection, args: unknown[]) => Promise<SettingsActionOutcome>
}

/** The identity whose overlay this connection reads and writes. */
function subjectOf(conn: Connection): string {
  return conn.principal?.subject ?? ''
}

/** A boolean or a number as itself, anything else by its shape: a string, a list, or a record may carry a secret. */
function loggable(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return `string(${value.length})`
  return Array.isArray(value) ? `list(${value.length})` : 'record'
}

export const SETTINGS_ACTIONS: Record<string, SettingsActionSpec> = {
  // [preferences] -> true
  // A client declares the Personal preferences the server consumes, once per
  // connection and again whenever one changes. They live on the CONNECTION,
  // in memory, and ride every action it runs as the ambient request
  // preferences (conversation-preferences.ts). Nothing is written to any
  // settings document: the preference belongs to the client.
  'preferences.declare': {
    requiredScope: 'conversations:read',
    handler: async (conn, args) => {
      const declared = sanitizePersonalPreferences(args[0])
      conn.preferences = declared
      // The values, not just the key names: what a conversation starts under
      // is decided here, and a wrong mode is unreadable from a key list.
      log('personal preferences declared', { connection_id: conn.id, subject: subjectOf(conn), ...declared })
      return { ok: true, value: true }
    },
  },
  // [{ days }] -> { count, titles }
  // What a sweep at `days` would settle right now, from the sweep's own
  // predicate. A client shows this before auto-settle is turned on or
  // shortened, so it is never a surprise. `admin`, because only an admin can
  // make the change it previews.
  'inbox.previewAutoSettle': {
    requiredScope: 'admin',
    handler: async (conn, args) => {
      const days = (args[0] as { days?: unknown } | undefined)?.days
      if (typeof days !== 'number' || !Number.isFinite(days) || days < 0) {
        return { ok: false, error: { code: 'invalid_days', message: 'days must be a number of zero or more' } }
      }
      const would = tabsAutoSettleWouldSettle(useSessionStore.getState(), days, Date.now())
      log('auto-settle preview', { connection_id: conn.id, subject: subjectOf(conn), days, count: would.length })
      return { ok: true, value: { count: would.length, titles: would.slice(0, 5).map((tab) => tab.customTitle || tab.title) } }
    },
  },
  // [] -> AiAssistWorkflow[]
  // The fixed AI-assisted workflows and their built-in prompts, so a client
  // that does not bundle `@ion/shared` (the phone) can show and reset the
  // prompt that `aiAssistPromptOverrides` replaces. The same read bar as
  // `settings.load`: the overrides themselves ride that action.
  'aiAssist.workflows': {
    requiredScope: 'conversations:read',
    handler: async (conn) => {
      log('ai-assist workflows listed', { connection_id: conn.id, count: AI_ASSIST_WORKFLOWS.length })
      return { ok: true, value: AI_ASSIST_WORKFLOWS }
    },
  },
  'settings.load': {
    requiredScope: 'conversations:read',
    handler: async (conn) => {
      try {
        // Credentials (the relay key, paired devices' secrets) are for a
        // connection that may change them; everyone else reads around them.
        const settings = readSettingsForSubject(subjectOf(conn))
        if (scopeSatisfies(conn.scopes, 'admin')) return { ok: true, value: settings }
        log('settings loaded without secrets', { connection_id: conn.id })
        return { ok: true, value: withoutSecrets(settings) }
      } catch (err) {
        warn('settings load failed', { connection_id: conn.id, error: String(err) })
        return { ok: false, error: { code: 'settings_load_failed', message: String(err) } }
      }
    },
  },
  'settings.save': {
    requiredScope: 'conversations:read',
    handler: async (conn, args) => {
      const patch = args[0]
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return { ok: false, error: { code: 'settings_save_failed', message: 'settings payload must be an object' } }
      }
      const subject = subjectOf(conn)
      if (!subject) {
        // An unauthenticated connection has no overlay to write. Refuse
        // loudly rather than dropping the write the way the old optional
        // chain did.
        warn('settings save refused: connection has no principal subject', { connection_id: conn.id })
        return { ok: false, error: { code: 'settings_save_failed', message: 'no identity to store settings against' } }
      }
      const { environment, personal, droppedServerOwned, clientOwned } = partitionSettingsPatch(patch as Record<string, unknown>)
      if (clientOwned.length > 0) {
        // Refused whole, so nothing half-applies. A client that sends one has
        // drifted from the registry: storing it would recreate the server-held
        // copy of a preference that is the client's own.
        warn('settings save refused: keys belong to the client', { connection_id: conn.id, subject, keys: clientOwned })
        return { ok: false, error: { code: 'settings_wrong_scope', message: `${clientOwned.join(', ')} are kept on the client, not on a server` } }
      }
      if (droppedServerOwned.length > 0) {
        log('server-owned keys dropped from patch; disk wins', { connection_id: conn.id, keys: droppedServerOwned })
      }
      let prev: Record<string, unknown> = {}
      try { prev = readSettings() } catch (err) {
        warn('prior environment settings read failed before save', { error: String(err) })
      }
      const changed = Object.keys(environment).filter((key) => JSON.stringify(environment[key]) !== JSON.stringify(prev[key]))
      // Enterprise policy outranks the scope gate: a sealed key is refused
      // for an admin too, and a hidden group's key for the connection it is
      // hidden from. Only the account keys that actually change are judged
      // for hiding; the environment keys that change are judged for both.
      let prevPersonal: Record<string, unknown> = {}
      try { prevPersonal = readSettingsForSubject(subject) } catch (err) {
        warn('prior overlay read failed before save', { subject, error: String(err) })
      }
      const changedPersonal = Object.keys(personal).filter((key) => JSON.stringify(personal[key]) !== JSON.stringify(prevPersonal[key]))
      const sealRefusal = settingsSealRefusal(conn, currentEnterprisePolicy(), [...changed, ...changedPersonal])
      if (sealRefusal) {
        warn('settings save refused by enterprise policy', { connection_id: conn.id, subject, transport: conn.transport, code: sealRefusal.code, keys: sealRefusal.keys })
        return { ok: false, error: { code: sealRefusal.code, message: sealRefusal.message } }
      }
      if (changed.length > 0 && !scopeSatisfies(conn.scopes, 'admin')) {
        warn('environment settings refused: connection lacks admin', { connection_id: conn.id, subject, transport: conn.transport, keys: changed, granted_scopes: conn.scopes })
        return { ok: false, error: { code: 'settings_locked', message: `changing ${changed.join(', ')} requires the admin scope on this server` } }
      }
      try {
        if (changed.length > 0) {
          // Merge over disk rather than replacing it: `writeSettings` serialises
          // exactly what it is handed, and the document on disk carries keys
          // no client ever sends (the server-owned ones above).
          const merged: Record<string, unknown> = { ...prev, ...environment }
          persistAndBroadcastSettings(merged, prev)
          // Who changed a server-wide setting, from what, to what. Values are
          // logged for booleans and numbers only: anything else can hold a secret.
          for (const key of changed) {
            log('environment setting changed', { connection_id: conn.id, subject, transport: conn.transport, key, from: loggable(prev[key]), to: loggable(environment[key]) })
          }
        }
        if (Object.keys(personal).length > 0) {
          writeSettingsForSubject(subject, personal)
          // This person's other clients (another window, another machine on
          // the same server) converge on the change. The third argument keeps
          // it from reaching anyone else (`protocol/events.ts`).
          for (const [key, value] of Object.entries(personal)) broadcast('ion:settings-changed', key, value, subject)
          // A phone renders the projected list, which carries this person's
          // overlay values. The overlay write passes no funnel that would
          // refresh it, so refresh it here when a projected key changed.
          const changedProjected = changedPersonal.filter(isProjectableKey)
          if (changedProjected.length > 0) {
            log('account settings changed; refreshing the projected snapshot', { connection_id: conn.id, subject, keys: changedProjected })
            broadcastDesktopSettingsSnapshot(`settings.save:${subject}`)
          }
        }
        return { ok: true, value: { ok: true } }
      } catch (err) {
        warn('settings save failed', { connection_id: conn.id, error: String(err) })
        return { ok: false, error: { code: 'settings_save_failed', message: String(err) } }
      }
    },
  },
}

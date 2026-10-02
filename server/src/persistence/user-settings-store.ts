/**
 * user-settings-store — per-identity Studio preferences.
 *
 * `settings.json` holds ONE settings document for the environment. That is
 * the right model for the Electron desktop, where the machine's operator and
 * the environment are the same person. It is the wrong model the moment a
 * server serves browser clients: two people signed into the same Environment
 * would fight over one shared toggle, and — the reported symptom — a
 * browser client had no writable settings at all, so changing a setting
 * and reloading brought it back.
 *
 * A signed-in client therefore gets an OVERLAY keyed by its principal
 * subject, stored beside the environment document. Reads merge the overlay
 * over the environment defaults, so a preference the user has never touched
 * still follows the environment; writes only ever touch that user's own
 * overlay, so one client can never move another's UI.
 *
 * Studio is not an exception to this. It reaches the server over the same
 * studio-wire any other client speaks (ADR-033), so its connection carries a
 * principal — `local:<username>` on a desktop that fronts no identity
 * provider — and its personal preferences land in an overlay like everyone
 * else's. The Environment document stays the base layer beneath it.
 *
 * Because of that, a server-side consumer of a personal preference must read
 * through `readSettingsForSubject` (normally via
 * `persistence/effective-settings.ts`) and never through `readSettings`
 * alone. Reading the Environment copy is what let Studio save a new default
 * thinking level, display it, and still start conversations on the old one.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'fs'
import { isEnvironmentOwnedSettingsKey } from '@ion/shared/settings-classification'
import { createHash } from 'crypto'
import { join } from 'path'
import { dataDir } from '../paths'
import { atomicWriteFileSync } from '../utils/atomicWrite'
import { readSettings } from './settings-store'
import { hasSealedSettings, keepStoredUnderSeal, withSealedSettings } from './sealed-settings'
import { forceFlushTabs } from '../store/session-store-force-flush'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void { _log('user-settings', msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn('user-settings', msg, fields) }

function overlayDir(): string {
  return join(dataDir(), 'user-settings')
}

/**
 * A subject is an IdP-issued string that may contain anything (`|`, `/`, a
 * full URL). Hashing gives a fixed, filesystem-safe name and keeps the
 * identity out of a directory listing; the subject is recorded inside the
 * file so an operator can still tell whose overlay it is.
 */
function overlayFile(subject: string): string {
  const digest = createHash('sha256').update(subject).digest('hex').slice(0, 32)
  return join(overlayDir(), `${digest}.json`)
}

export interface OverlayDocument {
  subject: string
  settings: Record<string, unknown>
}

function readOverlay(subject: string): Record<string, unknown> {
  const path = overlayFile(subject)
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as OverlayDocument
    return parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {}
  } catch (err) {
    // A corrupt overlay must not lock the user out of their own Studio: fall
    // back to the environment defaults and say so, rather than throwing on
    // every load.
    warn('overlay unreadable; falling back to environment settings', { error: String(err) })
    return {}
  }
}

/** Where `subject`'s overlay lives on disk. For the scope migration's backup. */
export function overlayFilePath(subject: string): string {
  return overlayFile(subject)
}

/** Every overlay on disk, raw: Environment keys included. For the scope migration only; ordinary readers use `readSettingsForSubject`. */
export function listOverlays(): OverlayDocument[] {
  if (!existsSync(overlayDir())) return []
  const out: OverlayDocument[] = []
  for (const name of readdirSync(overlayDir())) {
    if (!name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(readFileSync(join(overlayDir(), name), 'utf-8')) as Partial<OverlayDocument>
      if (typeof parsed.subject === 'string' && parsed.settings && typeof parsed.settings === 'object') {
        out.push({ subject: parsed.subject, settings: parsed.settings })
      }
    } catch (err) {
      warn('overlay unreadable while listing; skipped', { file: name, error: String(err) })
    }
  }
  return out
}

/** Replace `subject`'s overlay outright. For the scope migration, which removes keys; every other writer merges through `writeSettingsForSubject`. */
export function replaceOverlay(subject: string, settings: Record<string, unknown>): void {
  mkdirSync(overlayDir(), { recursive: true })
  const next: OverlayDocument = { subject, settings }
  atomicWriteFileSync(overlayFile(subject), JSON.stringify(next, null, 2))
  log('overlay replaced', { key_count: Object.keys(settings).length })
}

/**
 * Environment settings with this subject's overlay applied on top.
 *
 * Environment-owned keys (`@ion/shared/settings-classification`) never come
 * from the overlay: a client used to save its whole document here, so an
 * overlay written before the ownership split can still carry a stale
 * `remoteEnabled` that would shadow the Environment's real value.
 *
 * A setting the enterprise policy seals to a value reads as that value for
 * every subject (`sealed-settings.ts`).
 */
export function readSettingsForSubject(subject: string): Record<string, unknown> {
  const base = readSettings()
  if (!subject) return base
  // The seal goes on last: an overlay value must not shadow a sealed Account setting.
  return withSealedSettings({ ...base, ...stripEnvironmentOwned(readOverlay(subject)) })
}

function stripEnvironmentOwned(settings: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(settings)) {
    if (!isEnvironmentOwnedSettingsKey(key)) out[key] = value
  }
  return out
}

/**
 * Merge `patch` into this subject's overlay.
 *
 * A merge, not a replace: the client sends the whole settings document it
 * holds, but only the keys it actually carries should become user-scoped.
 * Replacing would freeze every environment default into the overlay at the
 * moment of the first write, so a later change to the environment document
 * would stop reaching this user.
 */
export function writeSettingsForSubject(subject: string, patch: Record<string, unknown>): void {
  if (!subject) {
    warn('refusing to write an overlay with no subject')
    return
  }
  mkdirSync(overlayDir(), { recursive: true })
  // The overlay holds personal keys only; an environment-owned key that
  // arrives here is a caller's mistake and is dropped rather than shadowing
  // the Environment document on the next read.
  const stored = readOverlay(subject)
  const merged = { ...stored, ...patch }
  // A sealed Account setting keeps what this overlay already holds.
  const kept = hasSealedSettings() ? keepStoredUnderSeal(merged, stored) : []
  if (kept.length > 0) log('sealed keys kept their stored overlay values', { keys: kept })
  const next: OverlayDocument = { subject, settings: stripEnvironmentOwned(merged) }
  atomicWriteFileSync(overlayFile(subject), JSON.stringify(next, null, 2))
  log('overlay written', { key_count: Object.keys(next.settings).length })
  // The published `liveResolvedModel` is derived from these keys. Nothing in
  // the session store changed, so nothing else would republish it.
  const modelKeys = Object.keys(patch).filter((key) => RESOLVED_MODEL_INPUT_KEYS.has(key))
  if (modelKeys.length > 0) {
    log('model default changed; republishing resolved models', { keys: modelKeys })
    forceFlushTabs()
  }
}

/** Account settings the conversation model resolver reads (model-resolution.ts). */
const RESOLVED_MODEL_INPUT_KEYS: ReadonlySet<string> = new Set(['preferredModel', 'engineDefaultModel'])

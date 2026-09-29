import { existsSync, readFileSync, copyFileSync } from 'fs'
import { join } from 'path'
import { dataDir } from '../paths'
import { atomicWriteFileSync } from '../utils/atomicWrite'
import { encryptSensitiveSettings, decryptSensitiveSettings } from '../utils/secretStore'
import { log as _log, error as _error } from '../logger'
import type { SessionPrincipal } from '@ion/shared/types-engine'
import type { PersistedTab, PersistedTabState } from '@ion/shared/types'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('principal-backfill', msg, fields)
}

function error(msg: string, fields?: Record<string, unknown>): void {
  _error('principal-backfill', msg, fields)
}

/**
 * Marker filename for the one-shot backfill. Present under `dataDir()` once
 * this has run to completion; the `-v1` suffix leaves room for a future
 * backfill generation without colliding with a run that already happened.
 */
export const BACKFILL_MARKER_FILENAME = '.principal-backfill-v1'

interface PersistedStudioTerminalsFile {
  version: 1
  terminals: Array<{ key: string; history: string; exitCode: number | null; cwd: string; principalSubject?: string }>
}

/** Stamps `principalSubject` onto every record in `records` missing one, in place. Returns the count stamped. */
function stampMissing<T extends { principalSubject?: string }>(records: T[], subject: string): number {
  let stamped = 0
  for (const record of records) {
    if (!record.principalSubject) {
      record.principalSubject = subject
      stamped++
    }
  }
  return stamped
}

/**
 * Backs up `path` to `<path>.pre-principal.bak` (only when `path` exists),
 * writes `contents` to `path`, then re-reads the backup and verifies its
 * record count (via `countRecords`) equals `expectedCount` -- the count the
 * caller computed from `contents`. A mismatch means the write and the backup
 * disagree about how many records exist; logs an ERROR and returns false so
 * the caller can report the file as not backfilled, without ever writing a
 * result whose record count nobody has verified.
 */
function backupWriteVerify(
  path: string,
  contents: string,
  mode: number,
  expectedCount: number,
  countRecords: (raw: string) => number,
): boolean {
  const backupPath = `${path}.pre-principal.bak`
  if (existsSync(path)) {
    copyFileSync(path, backupPath)
  }
  atomicWriteFileSync(path, contents, mode)
  if (!existsSync(backupPath)) {
    // No prior file existed to back up (a fresh state file created by this
    // backfill run) -- nothing to verify a count against.
    return true
  }
  let backupCount: number
  try {
    backupCount = countRecords(readFileSync(backupPath, 'utf-8'))
  } catch (err) {
    error('backup verify failed: could not re-read backup', { path: backupPath, error: String(err) })
    return false
  }
  if (backupCount !== expectedCount) {
    error('backup verify failed: record count mismatch; backfill aborted for this file', {
      path,
      backupCount,
      writtenCount: expectedCount,
    })
    return false
  }
  return true
}

function backfillTabs(dir: string, subject: string): void {
  const path = join(dir, 'tabs.json')
  if (!existsSync(path)) {
    log('tabs.json absent; nothing to backfill')
    return
  }
  let state: PersistedTabState
  try {
    state = JSON.parse(readFileSync(path, 'utf-8')) as PersistedTabState
  } catch (err) {
    error('tabs.json unreadable; skipping backfill', { error: String(err) })
    return
  }
  const tabs: PersistedTab[] = Array.isArray(state.tabs) ? state.tabs : []
  const settled: PersistedTab[] = Array.isArray(state.settledHistory) ? state.settledHistory : []
  const beforeCount = tabs.length + settled.length
  const stamped = stampMissing(tabs, subject) + stampMissing(settled, subject)
  if (stamped === 0) {
    log('tabs.json: no unowned records; nothing to backfill')
    return
  }
  const contents = JSON.stringify(state, null, 2)
  const ok = backupWriteVerify(path, contents, 0o600, tabs.length + settled.length, (raw) => {
    const parsed = JSON.parse(raw) as PersistedTabState
    return (Array.isArray(parsed.tabs) ? parsed.tabs.length : 0) + (Array.isArray(parsed.settledHistory) ? parsed.settledHistory.length : 0)
  })
  if (ok) {
    log('tabs.json backfilled', { stamped, total: beforeCount })
  }
}

function backfillStudioTerminals(dir: string, subject: string): void {
  const path = join(dir, 'studio-terminals.json')
  if (!existsSync(path)) {
    log('studio-terminals.json absent; nothing to backfill')
    return
  }
  let file: PersistedStudioTerminalsFile
  try {
    file = JSON.parse(readFileSync(path, 'utf-8')) as PersistedStudioTerminalsFile
  } catch (err) {
    error('studio-terminals.json unreadable; skipping backfill', { error: String(err) })
    return
  }
  const terminals = Array.isArray(file.terminals) ? file.terminals : []
  const stamped = stampMissing(terminals, subject)
  if (stamped === 0) {
    log('studio-terminals.json: no unowned records; nothing to backfill')
    return
  }
  const contents = JSON.stringify(file)
  const ok = backupWriteVerify(path, contents, 0o600, terminals.length, (raw) => {
    const parsed = JSON.parse(raw) as PersistedStudioTerminalsFile
    return Array.isArray(parsed.terminals) ? parsed.terminals.length : 0
  })
  if (ok) {
    log('studio-terminals.json backfilled', { stamped, total: terminals.length })
  }
}

/**
 * Paired-device records live inside `settings.json`'s `pairedDevices` array
 * (there is no standalone device file yet -- `credentials.json` is minted by
 * a later child's auth store; this is the "credentials.json-equivalent
 * device file" the manifest refers to today). `sharedSecret` and
 * `relayOidcSubject` on each device are encrypted at rest by the same
 * field-level scheme `settings-store.ts` uses, so this reads and writes
 * through `decryptSensitiveSettings`/`encryptSensitiveSettings` directly
 * rather than reusing `readSettings`/`writeSettings` -- those resolve
 * `SETTINGS_FILE` from `dataDir()` too, but as a `const` fixed at module
 * load, so this function takes an explicit `dir` parameter instead and
 * builds its own path from it, guaranteeing a backfill under a test's
 * `ION_DATA_DIR` never touches the real machine's settings regardless of
 * import order.
 */
function backfillPairedDevices(dir: string, subject: string): void {
  const path = join(dir, 'settings.json')
  if (!existsSync(path)) {
    log('settings.json absent; nothing to backfill')
    return
  }
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
  } catch (err) {
    error('settings.json unreadable; skipping backfill', { error: String(err) })
    return
  }
  const settings = decryptSensitiveSettings(raw)
  const devices: Array<{ principalSubject?: string }> = Array.isArray(settings.pairedDevices) ? settings.pairedDevices : []
  const stamped = stampMissing(devices, subject)
  if (stamped === 0) {
    log('settings.json: no unowned paired devices; nothing to backfill')
    return
  }
  const contents = JSON.stringify(encryptSensitiveSettings(settings), null, 2)
  const ok = backupWriteVerify(path, contents, 0o600, devices.length, (rawBackup) => {
    const parsed = JSON.parse(rawBackup) as Record<string, unknown>
    return Array.isArray(parsed.pairedDevices) ? parsed.pairedDevices.length : 0
  })
  if (ok) {
    log('settings.json paired devices backfilled', { stamped, total: devices.length })
  }
}

/**
 * One-shot principal backfill (manifest spec 06 §Functional "Backfill at
 * first start"): stamps every `PersistedTab`, `studio-terminals.json`
 * record, and paired-device record that has no `principalSubject` with the
 * local principal's subject. Idempotent via {@link BACKFILL_MARKER_FILENAME}
 * -- a second call with the marker present is a no-op.
 *
 * Conversation-header stamping is NOT done here: per the manifest, an
 * unowned conversation header is stamped by the engine itself the first time
 * its tab calls `start_session` after this server starts sending a
 * principal -- there is no direct-write path for conversation headers here.
 *
 * Each file is independently backed up, written, and count-verified; a
 * failure on one file is logged and does not prevent the others from being
 * attempted, and does not stop the marker from being written -- an
 * unconditional retry of a file this run could not safely rewrite every
 * future boot is worse than logging the one failure loudly and moving on.
 */
export async function runPrincipalBackfill(dir: string = dataDir(), principal: SessionPrincipal): Promise<void> {
  const markerPath = join(dir, BACKFILL_MARKER_FILENAME)
  if (existsSync(markerPath)) {
    log('backfill marker present; skipping')
    return
  }
  log('backfill starting', { subject: principal.subject })
  backfillTabs(dir, principal.subject)
  backfillStudioTerminals(dir, principal.subject)
  backfillPairedDevices(dir, principal.subject)
  try {
    atomicWriteFileSync(markerPath, new Date().toISOString() + '\n', 0o644)
    log('backfill marker written', { path: markerPath })
  } catch (err) {
    // The marker itself failing to write means every future boot re-attempts
    // the backfill (each already-stamped record is a no-op via stampMissing),
    // so this is loud but not fatal.
    error('backfill marker write failed; backfill will re-run on next boot', { error: String(err) })
  }
}

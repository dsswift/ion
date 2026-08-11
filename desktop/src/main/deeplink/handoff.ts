/**
 * Handoff-file transport.
 *
 * A caller with a payload too large for a URL — or one that should not appear in
 * the system's opened-URL logging — writes it as JSON to
 * `~/.ion/deeplink-requests/<uuid>.json` and opens `ion://<action>?req=<uuid>`.
 *
 * ── Why the file is read once and deleted ────────────────────────────────────
 * A request is a one-shot instruction, not a document. Deleting on read means a
 * leftover file cannot be replayed later by a second click on the same link, and
 * the directory cannot grow without bound. Deletion happens BEFORE the payload
 * is acted on, so an action that throws still consumes its request rather than
 * leaving a live one on disk.
 *
 * ── Why staleness is enforced ────────────────────────────────────────────────
 * A request whose file was written long ago is not a request anyone is waiting
 * on. Without a TTL, a file written days earlier (a crashed run, an aborted
 * script) would fire the moment someone clicked an old link. The window is
 * deliberately short: a legitimate caller writes the file and opens the URL in
 * the same breath.
 *
 * ── Why the mode is checked ──────────────────────────────────────────────────
 * The trust model says a local process wrote this. A group- or world-writable
 * file breaks that: another account could have replaced its contents between the
 * write and the read. Refusing a permissive file keeps "on disk under my home"
 * from being weaker than it looks.
 */

import { existsSync, readFileSync, statSync, unlinkSync, mkdirSync, chmodSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { log as _log, warn as _warn } from '../logger'
import { validateHandoffPayload, type DeepLinkPayload } from './parse'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('deeplink', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('deeplink', msg, fields)
}

export const HANDOFF_DIR = join(homedir(), '.ion', 'deeplink-requests')

/** Maximum age of a handoff file. Beyond this it is stale and refused. */
export const HANDOFF_TTL_MS = 60_000

/** Maximum handoff file size. Generous for prose, hostile to a disk-filler. */
export const HANDOFF_MAX_BYTES = 1024 * 1024

/**
 * Ensure the handoff directory exists with 0700.
 *
 * Called at startup so a caller has somewhere to write before the first
 * request, rather than having to create the directory itself (and possibly
 * create it with the wrong mode).
 */
export function ensureHandoffDir(): void {
  try {
    mkdirSync(HANDOFF_DIR, { recursive: true, mode: 0o700 })
    // mkdir's mode is umask-masked, so assert it explicitly.
    chmodSync(HANDOFF_DIR, 0o700)
  } catch (err) {
    warn('could not create handoff directory', { path: HANDOFF_DIR, error: String(err) })
  }
}

export type HandoffResult =
  | { kind: 'ok'; payload: DeepLinkPayload; token: string }
  | { kind: 'error'; reason: string }

/**
 * Read, delete, and validate the handoff file for `id`.
 *
 * `id` must already have been validated as a UUID by `parseDeepLink` — it is
 * interpolated into a path, and this function re-checks rather than trusting
 * that it was.
 */
export function consumeHandoff(id: string): HandoffResult {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return { kind: 'error', reason: 'handoff id is not a uuid' }
  }

  const path = join(HANDOFF_DIR, `${id}.json`)
  if (!existsSync(path)) {
    return { kind: 'error', reason: 'handoff file not found' }
  }

  let raw: string
  try {
    const st = statSync(path)
    if (!st.isFile()) {
      return { kind: 'error', reason: 'handoff path is not a regular file' }
    }
    if (st.size > HANDOFF_MAX_BYTES) {
      // Delete it: an oversized file is not going to become valid, and leaving
      // it would let one bad write occupy the directory indefinitely.
      unlinkSync(path)
      return { kind: 'error', reason: `handoff file too large (${st.size} bytes)` }
    }
    // Group/other must have no access at all.
    if ((st.mode & 0o077) !== 0) {
      unlinkSync(path)
      return { kind: 'error', reason: 'handoff file is not private (expected 0600)' }
    }
    const age = Date.now() - st.mtimeMs
    if (age > HANDOFF_TTL_MS) {
      unlinkSync(path)
      return { kind: 'error', reason: `handoff file is stale (${Math.round(age / 1000)}s old)` }
    }
    raw = readFileSync(path, 'utf-8')
  } catch (err) {
    return { kind: 'error', reason: `handoff read failed: ${String(err)}` }
  } finally {
    // One-shot: consume the request whatever happens next, so it can never be
    // replayed and never accumulates.
    try {
      if (existsSync(path)) unlinkSync(path)
    } catch (err) {
      warn('could not delete handoff file', { path, error: String(err) })
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { kind: 'error', reason: `handoff json invalid: ${String(err)}` }
  }

  const token = typeof (parsed as { token?: unknown })?.token === 'string'
    ? ((parsed as { token: string }).token).trim()
    : ''
  if (token.length > 256 || /[\0\r\n]/.test(token)) {
    return { kind: 'error', reason: 'handoff token rejected' }
  }

  const validated = validateHandoffPayload(parsed)
  if (validated.kind === 'error') return validated

  log('handoff consumed', { id, action: validated.payload.action })
  return { kind: 'ok', payload: validated.payload, token }
}

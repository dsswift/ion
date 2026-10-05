/**
 * `ion://` links opened by a remote client (a phone, a browser).
 *
 * The local desktop receives a link from its OS and shows the confirmation in
 * its own window. A remote client sends the URL itself with `deeplink.open`,
 * so the request goes back to that client alone and only that connection may
 * answer it. A remote action is always treated as untrusted: the capability
 * token is a local secret, and a link that reached a phone came from somewhere
 * else. Navigation links run nothing and resolve at once.
 */
import type { DeepLinkActionOutcome, DeepLinkOpenResult } from '@ion/shared/types-ipc-deeplink'
import { log as _log, warn as _warn } from '../logger'
import type { Connection } from '../protocol/connection'
import { connOwnsConversation, connOwnsTab } from '../protocol/ownership'
import { resolveExt, type ResolvedExt } from './action-ext'
import { buildConfirmRequest, CONFIRM_TIMEOUT_MS } from './confirm'
import { executeDeepLinkAction } from './execute'
import { resolveNavigation } from './navigate'
import { isNavigation, parseDeepLink, type DeepLinkActionPayload, type DeepLinkPayload } from './parse'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('deeplink', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('deeplink', msg, fields)
}

/** Remote confirmation ids carry this prefix so confirmResult can route them. */
export const REMOTE_CONFIRM_PREFIX = 'rdl-'

interface PendingRemote {
  connectionId: string
  payload: DeepLinkActionPayload
  ext: ResolvedExt | null
  timer: ReturnType<typeof setTimeout>
}

const pending = new Map<string, PendingRemote>()
let seq = 0

/**
 * The conversation or tab a link names that this connection's principal does
 * not own, or null when it owns everything the link names. A link that names
 * neither (a new conversation in a dir, a settings page, a file) is checked
 * by the action it runs, not here.
 */
function unownedTarget(conn: Connection, payload: DeepLinkPayload): string | null {
  if (payload.action === 'conversation' && !connOwnsConversation(conn, payload.id)) return `conversation ${payload.id}`
  if (payload.action === 'ext' && payload.conversation && !connOwnsConversation(conn, payload.conversation)) return `conversation ${payload.conversation}`
  if (payload.action === 'terminal' && payload.tabId && !connOwnsTab(conn, payload.tabId)) return `tab ${payload.tabId}`
  return null
}

const NOT_OWNED = 'This link names a conversation you do not have access to.'

/** Resolve a link a remote client opened. */
export async function openDeepLinkForConnection(conn: Connection, url: string): Promise<DeepLinkOpenResult> {
  const connectionId = conn.id
  const parsed = parseDeepLink(url)
  if (parsed.kind === 'error') {
    warn('remote deep link rejected', { connection_id: connectionId, reason: parsed.reason })
    return { kind: 'error', reason: parsed.reason }
  }
  if (parsed.kind === 'handoff') {
    // A handoff file lives on this host; only a local caller could have written it.
    warn('remote deep link rejected: handoff is local-only', { connection_id: connectionId })
    return { kind: 'error', reason: 'This link only works on the computer that created it.' }
  }
  const payload = parsed.request.payload
  const unowned = unownedTarget(conn, payload)
  if (unowned) {
    warn('remote deep link refused: not owned', { connection_id: connectionId, subject: conn.principal?.subject ?? '', action: payload.action, target: unowned })
    return { kind: 'error', reason: NOT_OWNED }
  }
  if (isNavigation(payload)) {
    const nav = await resolveNavigation(payload)
    return nav.ok ? { kind: 'navigate', target: nav.target } : { kind: 'error', reason: nav.reason }
  }
  if (payload.action === 'terminal' && !payload.tabId) {
    return { kind: 'error', reason: 'A terminal link opened remotely must name its conversation.' }
  }
  let ext: ResolvedExt | null = null
  if (payload.action === 'ext') {
    const resolution = resolveExt(payload)
    if (!resolution.ok) return { kind: 'error', reason: resolution.error }
    ext = resolution.ext
  }

  const id = `${REMOTE_CONFIRM_PREFIX}${++seq}-${Date.now()}`
  const timer = setTimeout(() => {
    if (pending.delete(id)) warn('remote confirmation timed out; treating as declined', { id, connection_id: connectionId })
  }, CONFIRM_TIMEOUT_MS)
  pending.set(id, { connectionId, payload, ext, timer })
  log('remote confirmation requested', { id, connection_id: connectionId, action: payload.action })
  return { kind: 'confirm', id, request: buildConfirmRequest(id, 'remote', payload, false, ext) }
}

/**
 * Settle a remote confirmation. Returns null for an id that is not a remote
 * one, so the caller falls through to the local flow. Only the connection
 * that opened the link may answer it.
 */
export async function settleRemoteConfirmation(conn: Connection, id: string, approved: boolean): Promise<DeepLinkActionOutcome | null> {
  const connectionId = conn.id
  if (!id.startsWith(REMOTE_CONFIRM_PREFIX)) return null
  const entry = pending.get(id)
  if (!entry) {
    log('remote confirmation result for unknown id (expired or settled)', { id, connection_id: connectionId })
    return { ok: false, error: 'This request has expired. Open the link again.' }
  }
  if (entry.connectionId !== connectionId) {
    warn('remote confirmation result refused: wrong connection', { id, connection_id: connectionId })
    return { ok: false, error: 'Only the device that opened the link can answer it.' }
  }
  pending.delete(id)
  clearTimeout(entry.timer)
  if (!approved) {
    log('remote deep link declined', { id, action: entry.payload.action })
    return { ok: false, error: 'declined' }
  }
  // Ownership can change while a confirmation waits; check again before running.
  const unowned = unownedTarget(conn, entry.payload)
  if (unowned) {
    warn('remote deep link refused at approval: not owned', { id, connection_id: connectionId, subject: conn.principal?.subject ?? '', action: entry.payload.action, target: unowned })
    return { ok: false, error: NOT_OWNED }
  }
  try {
    const outcome = await executeDeepLinkAction(entry.payload, entry.ext)
    log('remote deep link outcome', { id, action: entry.payload.action, ok: outcome.ok, error: outcome.error ?? '' })
    return { ok: outcome.ok, error: outcome.error, tabId: outcome.tabId }
  } catch (err) {
    warn('remote deep link action failed', { id, action: entry.payload.action, error: String(err) })
    return { ok: false, error: 'The deep link action could not be completed.' }
  }
}

/** Test seam. */
export function resetRemoteDeepLinksForTests(): void {
  for (const entry of pending.values()) clearTimeout(entry.timer)
  pending.clear()
  seq = 0
}

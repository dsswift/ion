/**
 * `deeplink.*` `studio_action`s: the renderer half of an `ion://` deep-link
 * confirmation, moved from the desktop's `ipc/deeplink.ts`.
 *
 * The server holds the pending confirmations (`deeplink/confirm.ts`) and
 * publishes them on `ion:deeplink-confirm-request` / `-settled`. These verbs
 * are how a client says whether it can show the dialog
 * (`setConfirmAvailability`) and what the operator decided (`confirmResult`).
 * Both are fire-and-forget on the client and reply `null`; a malformed
 * payload is logged and dropped, never applied.
 *
 * `conversations:operate`: an approval runs a command or starts a
 * conversation, and readiness decides whether an untrusted link waits for a
 * dialog or is refused outright.
 */
import { markDeepLinkConfirmationReady, markDeepLinkConfirmationUnavailable, rejectAllDeepLinkConfirmations, resolveDeepLinkConfirmation } from '../deeplink/confirm'
import { handleDeepLink, markDeepLinksReady } from '../deeplink/dispatch'
import { openDeepLinkForConnection, settleRemoteConfirmation } from '../deeplink/remote'
import { isLocalDesktop } from './lifecycle-actions'
import type { Connection } from './connection'
import { log as _log, warn as _warn } from '../logger'
import type { MiscActionSpec } from './misc-actions'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('deeplink-actions', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('deeplink-actions', msg, fields)
}

function owner(payload: unknown): 'overlay' | 'studio' | null {
  if (typeof payload !== 'object' || payload === null) return null
  const value = (payload as { owner?: unknown }).owner
  return value === 'overlay' || value === 'studio' ? value : null
}

const ok = { ok: true as const, value: null }

/** The verbs only the desktop that received the OS URL (or owns the window) may call. */
function localOnly(name: string, run: (conn: Connection, args: unknown[]) => unknown | Promise<unknown>): MiscActionSpec {
  return {
    requiredScope: 'admin',
    localOnly: true,
    handler: async (conn, args) => {
      if (!isLocalDesktop(conn)) {
        warn('refused: local desktop only', { connection_id: conn.id, action: name, transport: conn.transport, client_kind: conn.clientKind })
        return { ok: false, error: { code: 'local_only', message: `${name} is only available to the local desktop` } }
      }
      try {
        return { ok: true, value: (await run(conn, args)) ?? null }
      } catch (err) {
        warn('deep link action threw', { connection_id: conn.id, action: name, error: String(err) })
        return { ok: false, error: { code: 'action_failed', message: String(err) } }
      }
    },
  }
}

export const DEEPLINK_ACTIONS: Record<string, MiscActionSpec> = {
  // [url]: an `ion://` URL the desktop received from the OS. Dispatch runs
  // here, against the store this server owns; the desktop used to run it
  // in-process against a store nothing rendered once the store moved.
  'deeplink.dispatch': localOnly('deeplink.dispatch', (conn, a) => {
    const url = typeof a[0] === 'string' ? a[0] : ''
    if (!url) return { ok: false, error: 'url required' }
    log('dispatch requested', { connection_id: conn.id, url_length: url.length })
    return handleDeepLink(url)
  }),
  // []: the desktop's window has loaded; queued cold-launch links flush.
  'deeplink.ready': localOnly('deeplink.ready', () => { markDeepLinksReady(); return null }),
  // [{ owner }]: the window that hosted the confirmation dialog closed. Its
  // pending confirmations resolve to declined rather than hanging.
  'deeplink.surfaceClosed': localOnly('deeplink.surfaceClosed', (_conn, a) => {
    const value = owner(a[0])
    if (!value) { warn('surface closed ignored: invalid owner'); return null }
    markDeepLinkConfirmationUnavailable(value, 'window closed')
    rejectAllDeepLinkConfirmations(`${value} window closed`)
    return null
  }),
  // [{ owner, available }] -- the client can (or no longer can) show the dialog.
  'deeplink.setConfirmAvailability': {
    requiredScope: 'conversations:operate',
    handler: async (conn, args) => {
      const value = owner(args[0])
      const available = (args[0] as { available?: unknown } | null)?.available
      if (!value || typeof available !== 'boolean') { warn('confirmation availability ignored: invalid payload', { connection_id: conn.id }); return ok }
      if (available) markDeepLinkConfirmationReady(value)
      else markDeepLinkConfirmationUnavailable(value, 'renderer unavailable')
      log('confirmation availability set', { connection_id: conn.id, owner: value, available })
      return ok
    },
  },
  // [{ url }]: a remote client (phone, browser) opened an `ion://` link. A
  // navigation link answers with its target; an action link answers with a
  // confirmation for the caller to show, answered by confirmResult with
  // owner 'remote'. Any connection may call it; nothing runs without that answer.
  'deeplink.open': {
    requiredScope: 'conversations:operate',
    handler: async (conn, args) => {
      const url = (args[0] as { url?: unknown } | null)?.url
      if (typeof url !== 'string' || !url || url.length > 32768) {
        warn('deeplink.open ignored: bad url', { connection_id: conn.id })
        return { ok: true, value: { kind: 'error', reason: 'url required' } }
      }
      log('deeplink.open requested', { connection_id: conn.id, transport: conn.transport, url_length: url.length })
      return { ok: true, value: await openDeepLinkForConnection(conn, url) }
    },
  },
  // [{ id, owner, approved, tabId? }]
  'deeplink.confirmResult': {
    requiredScope: 'conversations:operate',
    handler: async (conn, args) => {
      const payload = args[0]
      if (typeof payload !== 'object' || payload === null) { warn('confirm result ignored: payload is not an object', { connection_id: conn.id }); return ok }
      const { id, owner: resultOwner, approved, tabId } = payload as { id?: unknown; owner?: unknown; approved?: unknown; tabId?: unknown }
      if (typeof id !== 'string' || !id || id.length > 128) { warn('confirm result ignored: bad id', { connection_id: conn.id }); return ok }
      if (resultOwner !== 'overlay' && resultOwner !== 'studio' && resultOwner !== 'remote') { warn('confirm result ignored: invalid owner', { connection_id: conn.id, id }); return ok }
      if (typeof approved !== 'boolean') { warn('confirm result ignored: approved is not a boolean', { connection_id: conn.id, id }); return ok }
      // A remote confirmation runs its action now and answers with the outcome.
      if (resultOwner === 'remote') {
        const outcome = await settleRemoteConfirmation(conn, id, approved)
        log('remote confirm result settled', { connection_id: conn.id, id, approved, ok: outcome?.ok ?? false })
        return { ok: true, value: outcome ?? { ok: false, error: 'not a remote confirmation' } }
      }
      if (tabId !== undefined && (typeof tabId !== 'string' || !tabId || tabId.length > 200)) { warn('confirm result ignored: bad tab id', { connection_id: conn.id, id }); return ok }
      log('confirm result received', { connection_id: conn.id, id, approved, owner: resultOwner })
      resolveDeepLinkConfirmation({ id, owner: resultOwner, approved, tabId })
      return ok
    },
  },
}

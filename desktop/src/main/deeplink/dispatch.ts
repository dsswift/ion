/**
 * `ion://` dispatcher — the single front door for every deep link.
 *
 * One place resolves the transport, one place resolves trust, and one place
 * routes to an action. That centralisation is deliberate: an action added later
 * cannot accidentally skip the trust gate, because it is not the action's job to
 * apply it.
 *
 * ── The trust model, and why an untrusted link is not simply refused ──────────
 * Two tiers, separated by whether the caller could read a 0600 file (see
 * token.ts for why that is a real boundary and not theatre):
 *
 *   - TRUSTED (valid token): execute immediately. This is `dev run`, a Makefile,
 *     a shell script — things that could already run any command as this user.
 *   - UNTRUSTED (no or wrong token): ask the operator first, showing exactly what
 *     would happen. This is a link from a web page or a chat message.
 *
 * Refusing untrusted links outright would kill the shareable-prompt use case;
 * executing them silently would be the `vscode://` hole (a page that runs a
 * command on one click). The confirmation is what lets both exist, and it is
 * also the better UX for a shared prompt: the recipient reads it before it runs.
 *
 * ── Cold-start queueing ──────────────────────────────────────────────────────
 * A link can launch the app. The renderer store does not exist for a second or
 * two afterwards, and every action needs it, so requests that arrive before the
 * store is ready are queued and flushed once it is. Dropping them would make a
 * link work only when Ion is already running.
 */

import { log as _log, warn as _warn } from '../logger'
import { parseDeepLink } from './parse'
import { consumeHandoff } from './handoff'
import { isTrustedToken } from './token'
import { runTerminalAction } from './action-terminal'
import { runPromptAction } from './action-prompt'
import { requestDeepLinkConfirmation } from './confirm'
import type { DeepLinkPayload } from './parse'
import type { ActionOutcome } from './action-terminal'
import type { DeepLinkConfirmOwner } from '../../shared/types-ipc'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('deeplink', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('deeplink', msg, fields)
}

/**
 * Whether the renderer store is up. Set by app-lifecycle once the window has
 * loaded; until then requests queue.
 */
let ready = false
const queued: string[] = []

/** Bound at wire time so dispatch can respect the enabled desktop surface. */
let presentConfirmation: (() => DeepLinkConfirmOwner | null) | null = null

export function configureDeepLinks(opts: { presentConfirmation: () => DeepLinkConfirmOwner | null }): void {
  presentConfirmation = opts.presentConfirmation
}

/** Flush anything that arrived before the renderer was ready. */
export function markDeepLinksReady(): void {
  ready = true
  if (queued.length === 0) return
  log('flushing queued deep links', { count: queued.length })
  const pending = queued.splice(0, queued.length)
  for (const url of pending) {
    void handleDeepLink(url).catch((err) => {
      warn('queued deep link failed', { error: String(err) })
    })
  }
}

/** Test seam: return the dispatcher to its pre-ready state. */
export function resetDeepLinkStateForTests(): void {
  ready = false
  queued.length = 0
}

export async function handleDeepLink(rawUrl: string): Promise<ActionOutcome> {
  if (!ready) {
    // Cold launch: the URL arrived before the renderer store existed.
    queued.push(rawUrl)
    log('deep link queued until renderer is ready', { queued: queued.length })
    return { ok: true }
  }

  const parsed = parseDeepLink(rawUrl)
  if (parsed.kind === 'error') {
    // Logged with the reason, never silently dropped: a caller with a malformed
    // link needs the log line to find out why nothing happened.
    warn('deep link rejected', { reason: parsed.reason })
    return { ok: false, error: parsed.reason }
  }

  let payload: DeepLinkPayload
  let token: string
  let transport: 'inline' | 'handoff'

  if (parsed.kind === 'handoff') {
    const resolved = consumeHandoff(parsed.id)
    if (resolved.kind === 'error') {
      warn('deep link handoff rejected', { reason: resolved.reason })
      return { ok: false, error: resolved.reason }
    }
    payload = resolved.payload
    token = resolved.token
    transport = 'handoff'
  } else {
    payload = parsed.request.payload
    token = parsed.request.token
    transport = 'inline'
  }

  const trusted = isTrustedToken(token)
  log('deep link received', {
    action: payload.action,
    transport,
    trust: trusted ? 'trusted' : 'untrusted',
    // The tab a terminal request targets is the field most worth having in the
    // log when a pane lands somewhere unexpected.
    tab_id: payload.action === 'terminal' ? payload.tabId : '',
  })

  if (!trusted) {
    const owner = presentConfirmation?.()
    if (!owner) {
      warn('deep link rejected: no confirmation surface', { action: payload.action })
      return { ok: false, error: 'No Ion window is available to approve this request.' }
    }
    const selectTab = payload.action === 'terminal' && !payload.tabId
    const confirmation = await requestDeepLinkConfirmation(payload, owner, selectTab)
    if (!confirmation.approved) {
      log('deep link declined by operator', { action: payload.action, transport })
      return { ok: false, error: 'declined' }
    }
    if (selectTab && payload.action === 'terminal') {
      payload = { ...payload, tabId: confirmation.tabId! }
    }
    log('deep link approved by operator', { action: payload.action, transport, owner })
  } else if (payload.action === 'terminal' && !payload.tabId) {
    warn('trusted terminal request rejected: no tabId')
    return { ok: false, error: 'A trusted terminal request must name its conversation.' }
  }

  let outcome: ActionOutcome
  try {
    outcome = payload.action === 'terminal'
      ? await runTerminalAction(payload)
      : await runPromptAction(payload)
  } catch (err) {
    warn('deep link action failed', {
      action: payload.action,
      transport,
      trust: trusted ? 'trusted' : 'untrusted',
      error: String(err),
    })
    return { ok: false, error: 'The deep link action could not be completed.' }
  }

  log('deep link outcome', {
    action: payload.action,
    transport,
    trust: trusted ? 'trusted' : 'untrusted',
    ok: outcome.ok,
    error: outcome.error ?? '',
  })
  return outcome
}

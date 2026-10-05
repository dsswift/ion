/**
 * `ion://ext/<routeId>` — run a slash command an extension registered as a
 * link route. Resolution happens before the trust gate, because the operator
 * must see the real command in the confirmation, not just a route id.
 */
import { isAbsolute } from 'node:path'
import { log as _log, warn as _warn } from '../logger'
import { linkRoutesBoard } from '../engine/link-routes-wiring'
import { useSessionStore } from '../store/sessionStore'
import { conversationExists, tabForConversation } from './navigate'
import type { ExtRequest } from './parse'
import type { ActionOutcome } from './action-terminal'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('deeplink', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('deeplink', msg, fields)
}

/** An ext request with its route resolved, ready to confirm and run. */
export interface ResolvedExt {
  label: string
  /** The command that will be sent, arguments included. */
  command: string
}

export type ExtResolution = { ok: true; ext: ResolvedExt } | { ok: false; error: string }

/**
 * Find the route an ext link means. With a conversation open in a tab, the
 * route must be one that conversation can run. With a conversation that is
 * saved but closed, or with none, only a workspace-wide route qualifies: its
 * extension is not loaded anywhere the server can ask.
 */
export function resolveExt(req: ExtRequest): ExtResolution {
  let target: { tabId: string; conversationId: string } | null = null
  if (req.conversation) {
    if (!conversationExists(req.conversation)) return { ok: false, error: 'The link names a conversation that does not exist.' }
    const open = useSessionStore.getState().tabs.find((t) => t.conversationId === req.conversation)
    if (open) target = { tabId: open.id, conversationId: req.conversation }
  } else if (!req.dir || !isAbsolute(req.dir)) {
    return { ok: false, error: 'A link that opens a new conversation must name an absolute dir.' }
  }
  const resolved = linkRoutesBoard.resolve(req.routeId, target)
  if (!resolved) {
    warn('ext link refused: no route', { route_id: req.routeId, conversation_id: req.conversation })
    return { ok: false, error: `No extension route "${req.routeId}" is available here.` }
  }
  const command = req.args ? `${resolved.route.command} ${req.args}` : resolved.route.command
  log('ext link resolved', { route_id: req.routeId, producer: resolved.route.producer, key: resolved.key })
  return { ok: true, ext: { label: resolved.route.label, command } }
}

export async function runExtAction(req: ExtRequest, ext: ResolvedExt): Promise<ActionOutcome> {
  const s = useSessionStore.getState()
  try {
    const tabId = req.conversation
      ? await tabForConversation(req.conversation)
      : await s.createTabInDirectory(req.dir, undefined, true)
    if (!tabId) {
      warn('ext action failed: no conversation', { route_id: req.routeId })
      return { ok: false, error: 'The conversation could not be opened.' }
    }
    useSessionStore.getState().submit(tabId, ext.command)
    log('ext action completed', { route_id: req.routeId, tab_id: tabId, command_length: ext.command.length })
    return { ok: true, tabId }
  } catch (err) {
    warn('ext action threw', { route_id: req.routeId, error: String(err) })
    return { ok: false, error: String(err) }
  }
}

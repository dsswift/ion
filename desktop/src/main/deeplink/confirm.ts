import { IPC } from '../../shared/types'
import { log as _log, warn as _warn } from '../logger'
import { broadcast } from '../broadcast'
import type { DeepLinkPayload } from './parse'
import type { DeepLinkConfirmOwner, DeepLinkConfirmRequest, DeepLinkConfirmResult } from '../../shared/types-ipc'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('deeplink', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('deeplink', msg, fields)
}

export const CONFIRM_TIMEOUT_MS = 5 * 60_000

export interface DeepLinkConfirmation {
  approved: boolean
  tabId?: string
}

interface Pending {
  resolve: (decision: DeepLinkConfirmation) => void
  timer: ReturnType<typeof setTimeout>
  request: DeepLinkConfirmRequest
}

const pending = new Map<string, Pending>()
const readyOwners = new Set<DeepLinkConfirmOwner>()
let seq = 0

function settle(id: string, decision: DeepLinkConfirmation, reason: string): void {
  const entry = pending.get(id)
  if (!entry) {
    log('confirmation result for unknown id (already settled?)', { id, approved: decision.approved })
    return
  }
  pending.delete(id)
  clearTimeout(entry.timer)
  broadcast(IPC.DEEPLINK_CONFIRM_SETTLED, id)
  log('confirmation settled', { id, approved: decision.approved, reason, owner: entry.request.owner })
  entry.resolve(decision)
}

/** The selected renderer declares itself ready after its store and bridge load. */
export function markDeepLinkConfirmationReady(owner: DeepLinkConfirmOwner): void {
  readyOwners.add(owner)
  for (const entry of pending.values()) {
    if (entry.request.owner === owner) {
      broadcast(IPC.DEEPLINK_CONFIRM_REQUEST, entry.request)
    }
  }
}

export function markDeepLinkConfirmationUnavailable(owner: DeepLinkConfirmOwner, reason: string): void {
  readyOwners.delete(owner)
  for (const [id, entry] of pending) {
    if (entry.request.owner === owner) settle(id, { approved: false }, reason)
  }
}

export function requestDeepLinkConfirmation(
  payload: DeepLinkPayload,
  owner: DeepLinkConfirmOwner,
  selectTab = false,
): Promise<DeepLinkConfirmation> {
  const id = `dl-${++seq}-${Date.now()}`
  const request: DeepLinkConfirmRequest = payload.action === 'terminal'
    ? { id, owner, action: 'terminal', selectTab, tabId: payload.tabId, title: payload.title, cmd: payload.cmd, dir: payload.dir }
    : { id, owner, action: 'prompt', dir: payload.dir, text: payload.text, submit: payload.submit }

  return new Promise<DeepLinkConfirmation>((resolve) => {
    const timer = setTimeout(() => {
      warn('confirmation timed out; treating as declined', { id, action: payload.action, owner })
      settle(id, { approved: false }, 'timeout')
    }, CONFIRM_TIMEOUT_MS)
    pending.set(id, { resolve, timer, request })
    log('confirmation requested', { id, action: payload.action, owner, select_tab: selectTab })
    if (readyOwners.has(owner)) {
      broadcast(IPC.DEEPLINK_CONFIRM_REQUEST, request)
    }
  })
}

export function resolveDeepLinkConfirmation(result: DeepLinkConfirmResult): void {
  const entry = pending.get(result.id)
  if (!entry) {
    log('confirmation result for unknown id (already settled?)', { id: result.id, approved: result.approved })
    return
  }
  if (entry.request.owner !== result.owner) {
    warn('confirmation result ignored: wrong owner', { id: result.id, owner: result.owner })
    return
  }
  if (entry.request.selectTab && result.approved && !result.tabId) {
    warn('confirmation result ignored: selected tab missing', { id: result.id })
    return
  }
  settle(result.id, { approved: result.approved, tabId: result.tabId }, 'operator')
}

export function rejectAllDeepLinkConfirmations(reason: string): void {
  if (pending.size === 0) return
  warn('refusing outstanding confirmations', { count: pending.size, reason })
  for (const id of [...pending.keys()]) settle(id, { approved: false }, reason)
}

export function pendingConfirmationCountForTests(): number {
  return pending.size
}

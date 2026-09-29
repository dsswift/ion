/**
 * Sign-ins started for a client that finishes them somewhere else.
 *
 * A phone cannot receive a loopback callback on the server's host. It opens
 * the authorization page itself, lands on the provider's redirect, and hands
 * the final address back through `auth.completeSignIn`. What the exchange
 * needs in between (which MCP server, or Google's PKCE verifier and state)
 * waits here under an opaque flow id, for a bounded time.
 */
import { randomUUID } from 'crypto'
import { log as _log } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('oauth.pending-sign-ins', msg, fields)
}

export type PendingSignIn =
  | { kind: 'mcp'; mcpName: string }
  | { kind: 'google'; verifier: string; state: string }

/** Matches the engine's own hold on a pending MCP login. */
export const PENDING_SIGN_IN_TTL_MS = 10 * 60 * 1000

interface Entry {
  flow: PendingSignIn
  expiresAt: number
}

const pending = new Map<string, Entry>()

/** One provider or server has one credential, so a newer sign-in for it replaces the older one. */
function sameTarget(a: PendingSignIn, b: PendingSignIn): boolean {
  if (a.kind === 'mcp' && b.kind === 'mcp') return a.mcpName === b.mcpName
  return a.kind === b.kind
}

function sweep(now: number): void {
  for (const [flowId, entry] of pending) {
    if (entry.expiresAt <= now) {
      pending.delete(flowId)
      log('pending sign-in expired', { flow_id: flowId, kind: entry.flow.kind })
    }
  }
}

/** Hold `flow` for completion and return its flow id. */
export function registerPendingSignIn(flow: PendingSignIn, now = Date.now()): string {
  sweep(now)
  for (const [flowId, entry] of pending) {
    if (sameTarget(entry.flow, flow)) {
      pending.delete(flowId)
      log('pending sign-in replaced by a newer one', { flow_id: flowId, kind: flow.kind })
    }
  }
  const flowId = randomUUID()
  pending.set(flowId, { flow, expiresAt: now + PENDING_SIGN_IN_TTL_MS })
  log('pending sign-in registered', { flow_id: flowId, kind: flow.kind, ...(flow.kind === 'mcp' ? { mcp_name: flow.mcpName } : {}) })
  return flowId
}

export type PendingSignInLookup =
  | { ok: true; flow: PendingSignIn }
  | { ok: false; reason: 'unknown' | 'expired' }

/** The flow waiting under `flowId`, without consuming it. An expired one is dropped. */
export function lookupPendingSignIn(flowId: string, now = Date.now()): PendingSignInLookup {
  const entry = pending.get(flowId)
  if (!entry) return { ok: false, reason: 'unknown' }
  if (entry.expiresAt <= now) {
    pending.delete(flowId)
    log('pending sign-in expired at completion', { flow_id: flowId, kind: entry.flow.kind })
    return { ok: false, reason: 'expired' }
  }
  return { ok: true, flow: entry.flow }
}

/** Drop a flow once it completed. */
export function releasePendingSignIn(flowId: string): void {
  if (pending.delete(flowId)) log('pending sign-in released', { flow_id: flowId })
}

/** TEST ONLY. */
export function _resetPendingSignInsForTest(): void {
  pending.clear()
}

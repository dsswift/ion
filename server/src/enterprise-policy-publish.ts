/**
 * The one writer of `enterprisePolicyCache.policy`, and the signal that the
 * first read of it has settled. A `studio_welcome` sent before that read
 * carried no policy, and nothing told the client once it loaded: a fresh
 * install's desktop ran its updater despite an enterprise kill switch.
 */
import { createHash } from 'crypto'
import type { EnterprisePolicy } from '@ion/shared/types-engine'
import { log } from './logger'
import { managedEngineConfigSource } from './managed-config'
import { setManagedEngineConfigSource } from './persistence/settings-store'

/**
 * Enterprise policy cache (D-004), read from the engine's
 * get_enterprise_policy blob at startup and after every engine reconnect.
 * `allowedModels` filters the model cache (`state.ts`) so the iOS snapshot
 * projection (availableModels) honors the same policy as every other client
 * (D-011 parity). Kept here, free of the engine bridge `state.ts` builds on
 * import; `state.ts` re-exports it.
 */
export const enterprisePolicyCache = {
  policy: null as EnterprisePolicy | null,
  /**
   * The resolved new-conversation defaults policy (pre-D-004 single-policy
   * key). Populated at startup alongside `policy` and refreshed on every
   * sendSync fetch, so synchronous wire emitters can project it without an
   * RPC.
   */
  newConversationDefaults: null as {
    baseDirectory: string;
    engineProfileId: string;
    locked: boolean;
  } | null,
};

type Listener = (policy: EnterprisePolicy | null) => void

let settled = false
let settle!: () => void
const ready = new Promise<void>((resolve) => {
  settle = resolve
})
const listeners = new Set<Listener>()

function markSettled(reason: string): void {
  if (settled) return
  settled = true
  log('enterprise-policy', 'enterprise policy settled', { reason, has_policy: enterprisePolicyCache.policy !== null })
  settle()
}

/** A stable hash of a policy, for clients that skip an unchanged update. */
export function enterprisePolicyHash(policy: EnterprisePolicy | null): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(policy ?? null)).digest('hex')}`
}

/** Stores a freshly read policy, settles the first read, and tells subscribers when it changed. */
export function publishEnterprisePolicy(policy: EnterprisePolicy | null): void {
  const changed = enterprisePolicyHash(policy) !== enterprisePolicyHash(enterprisePolicyCache.policy)
  enterprisePolicyCache.policy = policy
  // A managed engine file replaces engine.json for this server's own reads
  // and writes of it.
  setManagedEngineConfigSource(managedEngineConfigSource(policy))
  if (!settled) {
    markSettled('read')
    return
  }
  if (!changed) return
  log('enterprise-policy', 'enterprise policy changed; publishing', { has_policy: policy !== null, listeners: listeners.size })
  for (const listener of listeners) listener(policy)
}

/** Settles the first read without a policy (the engine was unreachable, or the read failed). */
export function settleEnterprisePolicyUnread(reason: string): void {
  markSettled(reason)
}

/** The policy once its first read has settled. */
export async function settledEnterprisePolicy(): Promise<EnterprisePolicy | null> {
  await ready
  return enterprisePolicyCache.policy
}

export function onEnterprisePolicyChange(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// Ion Extension SDK — resource subsystem runtime.
//
// Implements ion.resources.declare(...) and ion.resources.onQuery(...).
// Static/dynamic registration path:
//   - Calls before init queue the declaration; included in init response.
//   - Calls after init go via ext/declare_resource RPC.
//
// The engine calls resource/query when a client subscribes; the runtime
// dispatches to the registered handler and returns the snapshot items.

import type {
  IonContext,
  ResourceDeclaration,
  ResourceDelta,
  ResourceFilter,
  ResourceHandle,
  ResourceItem,
} from './types'

// Module-scope registry of query handlers, keyed by kind.
const queryHandlers = new Map<
  string,
  (filter: ResourceFilter) => Promise<ResourceItem[]> | ResourceItem[]
>()

// Pre-init queue flushed into the init response.
const pendingInitResources: ResourceDeclaration[] = []

// Mirrors the pattern in runtime-async.ts: flips true after drainPendingResourceInit().
let initResolved = false

// Wired by runtime.ts via registerResourceRpcBridge after createIon() sets
// up its RPC plumbing. Avoids a circular dep between runtime.ts and this module.
type RpcRequest = (method: string, params: unknown) => Promise<unknown>
let rpcRequest: RpcRequest | null = null

/** Wired by runtime.ts during createIon(). */
export function registerResourceRpcBridge(fn: RpcRequest): void {
  rpcRequest = fn
}

/**
 * Called by runtime.ts inside the 'init' handler. Returns all pending
 * resource declarations and marks init as resolved so subsequent
 * declare() calls route through the RPC.
 */
export function drainPendingResourceInit(): { resources: ResourceDeclaration[] } {
  const out = { resources: pendingInitResources.slice() }
  pendingInitResources.length = 0
  initResolved = true
  return out
}

/** Called by runtime.ts if init has already resolved (respawn path). */
export function markResourceInitResolved(): void {
  initResolved = true
}

/** Builds the IonContext['resources'] API surface. */
export function buildResourcesAPI(): IonContext['resources'] {
  return {
    async declare(decl: ResourceDeclaration): Promise<ResourceHandle> {
      if (!initResolved) {
        // Pre-init: queue for inclusion in the init response.
        pendingInitResources.push({ kind: decl.kind })
      } else {
        // Post-init: declare via RPC so the engine wires the broker.
        if (!rpcRequest) throw new Error('ion.resources.declare: RPC bridge not wired')
        await rpcRequest('ext/declare_resource', { kind: decl.kind })
      }
      return {
        async publish(op: ResourceDelta['op'], item: ResourceItem): Promise<void> {
          if (!rpcRequest) throw new Error('ion.resources.publish: RPC bridge not wired')
          await rpcRequest('ext/publish_resource', { kind: decl.kind, op, item })
        },
      }
    },

    onQuery(
      kind: string,
      handler: (filter: ResourceFilter) => Promise<ResourceItem[]> | ResourceItem[],
    ): void {
      queryHandlers.set(kind, handler)
    },
  }
}

/**
 * Handle an incoming resource/query from the engine (sent when a client
 * subscribes to a kind). Returns the initial snapshot of items.
 */
export async function handleResourceQuery(params: {
  kind: string
  filter: ResourceFilter
}): Promise<ResourceItem[]> {
  const handler = queryHandlers.get(params.kind)
  if (!handler) return []
  return await handler(params.filter)
}

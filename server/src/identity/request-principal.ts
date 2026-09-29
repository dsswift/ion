/**
 * request-principal — the ambient identity of "who is making this call
 * right now", carried via Node's `AsyncLocalStorage` rather than threaded as
 * a parameter.
 *
 * `studio_action` dispatch (`protocol/actions.ts`) invokes
 * `useSessionStore.getState()[action](...args)` — the store's action
 * signatures are shared with the desktop's own in-process mirror and take no
 * connection/principal parameter. Threading one through would touch every
 * action in `FORWARDED_ACTIONS` (dozens, growing) purely to let a handful of
 * call sites (tab creation, the engine bridge) read the caller's identity.
 * `AsyncLocalStorage` gives an EXACT per-request-chain value instead: it
 * follows the actual async call graph (including awaits and promise chains
 * spawned within the wrapped function), so a concurrent second request on a
 * different connection never sees the first request's principal, without
 * either request's code needing to know the mechanism exists.
 *
 * `runAsPrincipal` wraps the single dispatch point for authenticated
 * inbound frames (`protocol/listener.ts`'s post-hello switch) plus the
 * relay-forwarded remote-command path (`remote/command-handler.ts`). A path
 * that never runs inside `runAsPrincipal` — desktop's own local IPC
 * handlers, which own the store directly and have no Studio-wire connection
 * at all — gets `undefined` from `currentPrincipal()`; every caller of this
 * module falls back to `localPrincipal()` in that case, which is exactly
 * today's un-attributed behavior, unchanged.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { StudioPrincipalSummary } from '@ion/shared/studio-wire/types'
import type { PersonalPreferences } from '@ion/shared/settings-registry'

/** The ambient identity for one request chain. `claims` never reaches a wire frame — see `hello.ts`'s `AuthResult` docblock. */
export interface RequestPrincipal {
  principal: StudioPrincipalSummary
  /** The Personal preferences the calling client declared for this connection. Held in memory for the life of the connection, never stored as settings. */
  preferences?: PersonalPreferences
  claims?: Record<string, unknown>
}

const storage = new AsyncLocalStorage<RequestPrincipal>()

/** Runs `fn` with `principal` as the ambient identity for its entire async call graph. */
export function runAsPrincipal<T>(principal: RequestPrincipal, fn: () => T): T {
  return storage.run(principal, fn)
}

/** The calling request chain's principal, or `undefined` outside any `runAsPrincipal` wrap. */
export function currentPrincipal(): StudioPrincipalSummary | undefined {
  return storage.getStore()?.principal
}

/** The calling request chain's raw auth claims (bearer only), or `undefined`. Never sent to a client. */
/** The calling client's Personal preferences, or `undefined` outside a request (a timer, an engine event). */
export function currentPreferences(): PersonalPreferences | undefined {
  return storage.getStore()?.preferences
}

export function currentClaims(): Record<string, unknown> | undefined {
  return storage.getStore()?.claims
}

/** TEST ONLY. Direct access to the storage instance for tests that need to assert isolation across concurrent runs. */
export function _requestPrincipalStorageForTest(): AsyncLocalStorage<RequestPrincipal> {
  return storage
}

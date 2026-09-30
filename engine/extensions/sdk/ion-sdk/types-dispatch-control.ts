import type { DispatchHistoryEntry } from './types'

/** Options for the retained name-addressed dispatch recall API. */
export interface RecallAgentOpts {
  /** Human-readable reason recorded by the engine. */
  reason?: string
}

/**
 * Full outcome of {@link DispatchControlContext.recallAgentByName}. `found` is
 * true only when a dispatch was recalled. `matchingDispatchIds` is set only
 * when `outcome` is `'ambiguous'` and lists every live dispatch in the
 * caller's scope carrying the name. `terminal` is set only when `outcome` is
 * `'completed'`: the one match finished before it could be recalled.
 */
export interface RecallAgentResult {
  found: boolean
  outcome: 'recalled' | 'not_found' | 'ambiguous' | 'completed'
  matchingDispatchIds?: string[]
  terminal?: DispatchHistoryEntry
}

/**
 * Full outcome of {@link DispatchControlContext.recallDispatchWithOutcome}.
 * `found` is true only when a dispatch was recalled. `terminal` is set only
 * when `outcome` is `'completed'`.
 */
export interface RecallDispatchResult {
  found: boolean
  outcome: 'recalled' | 'completed' | 'unauthorized' | 'not_found'
  terminal?: DispatchHistoryEntry
}

/** Options for collision-safe exact-ID dispatch recall. */
export interface RecallDispatchOpts {
  /** Human-readable reason recorded by the engine. */
  reason?: string
}

/** Dispatch recall controls mixed into the public IonContext interface. */
export interface DispatchControlContext {
  /**
   * Recalls the one live dispatch that carries `name` and resolves true when it
   * did. Resolves false when no dispatch carries the name, and also when
   * several do: the engine recalls nothing on an ambiguous name. Use
   * recallAgentByName to get the matching IDs, or recallDispatch with the
   * exact dispatch ID.
   */
  recallAgent(name: string, opts?: RecallAgentOpts): Promise<boolean>

  /**
   * Name-addressed recall with the full outcome. When several live dispatches
   * share the name, nothing is recalled and the result is `'ambiguous'` with
   * every matching dispatch ID, so you can retry with recallDispatch.
   */
  recallAgentByName(name: string, opts?: RecallAgentOpts): Promise<RecallAgentResult>

  /**
   * Preferred API. Recalls the exact background dispatch and its descendants.
   * The root context can recall every dispatch in its session; a dispatched
   * agent only its own descendants. Recalling one the caller does not own
   * rejects.
   */
  recallDispatch(dispatchId: string, opts?: RecallDispatchOpts): Promise<boolean>

  /**
   * Exact-ID recall with the full outcome: `'recalled'`, `'completed'` (the
   * dispatch had already finished; `terminal` says how), `'unauthorized'` (the
   * caller does not own it), or `'not_found'`. Never rejects for an
   * unauthorized target.
   */
  recallDispatchWithOutcome(dispatchId: string, opts?: RecallDispatchOpts): Promise<RecallDispatchResult>
}

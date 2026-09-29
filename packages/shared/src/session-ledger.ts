/**
 * session-ledger — pure helpers for a tab's first-class session ledger.
 *
 * The ledger is the data-model encoding of the session-cut invariant: a tab
 * holds ONE session id for its whole life, and a NEW id is appended ONLY at an
 * explicit checkpoint (clear / compaction / fork). A process or engine restart
 * resumes `currentSessionId` and appends nothing — restart literally cannot
 * fragment a conversation because there is no code path that appends on restart.
 *
 * Before the ledger, the per-tab `conversationIds[]` array was an ad-hoc list
 * that the restart path appended to on every relaunch (a new engine-minted id
 * each time), splitting one logical conversation across N disjoint files. The
 * ledger replaces that list with a reasoned, append-on-checkpoint structure.
 *
 * These helpers are pure (no store, no IPC) so they unit-test at a stable seam
 * and are shared between the renderer persistence path and any consumer.
 */
import type { SessionLedgerEntry, SessionCutReason } from './types-persistence'

/**
 * Derive a session ledger from a legacy persisted instance.
 *
 * Priority:
 *  1. If `sessions[]` is already present (post-migration file), return it as-is.
 *  2. Otherwise migrate the legacy `conversationIds[]` chain into ledger entries
 *     with reason `unknown` (the original cut reasons were never recorded),
 *     oldest first. createdAt is unknown for legacy ids, so it is seeded to 0 —
 *     a stable, non-lying sentinel (these entries predate ledger timestamping).
 *
 * Returns [] when neither source has any id (a fresh / empty instance).
 */
export function deriveLedger(inst: {
  sessions?: SessionLedgerEntry[]
  conversationIds?: string[]
}): SessionLedgerEntry[] {
  if (inst.sessions && inst.sessions.length > 0) {
    return inst.sessions
  }
  const ids = inst.conversationIds ?? []
  return ids.map((id) => ({ id, reason: 'unknown' as SessionCutReason, createdAt: 0 }))
}

/**
 * Resolve the current (live) session id for a persisted instance.
 *
 * Priority:
 *  1. Explicit `currentSessionId` (post-migration files persist it).
 *  2. The newest ledger entry (or migrated `conversationIds`) — the last id.
 *  3. A provided fallback (e.g. the tab's `lastKnownSessionId`).
 *
 * Returns '' when nothing is resolvable.
 */
export function resolveCurrentSessionId(
  inst: { currentSessionId?: string; sessions?: SessionLedgerEntry[]; conversationIds?: string[] },
  fallback?: string,
): string {
  if (inst.currentSessionId) return inst.currentSessionId
  const ledger = deriveLedger(inst)
  if (ledger.length > 0) return ledger[ledger.length - 1].id
  return fallback || ''
}

/**
 * Append a checkpoint cut to a ledger, returning a NEW ledger (immutable).
 *
 * The new entry's id becomes the current session id. `parentId` is the prior
 * current id (the session this one descends from), mirroring the engine's
 * on-disk `parentId`. Idempotent on id: if `newId` is already the newest entry,
 * the ledger is returned unchanged (guards double-fire of a cut handler).
 *
 * This is the ONLY function that grows a ledger. Restart paths must never call
 * it — that is what makes restart-fragmentation structurally impossible.
 */
export function appendCut(
  ledger: SessionLedgerEntry[],
  newId: string,
  reason: SessionCutReason,
  now: number,
): SessionLedgerEntry[] {
  if (ledger.length > 0 && ledger[ledger.length - 1].id === newId) {
    return ledger
  }
  const parentId = ledger.length > 0 ? ledger[ledger.length - 1].id : undefined
  return [...ledger, { id: newId, reason, createdAt: now, ...(parentId ? { parentId } : {}) }]
}

/**
 * Flatten a ledger to its ordered id list (oldest first). Used by readers that
 * still want the raw id chain (e.g. "copy every conversation file" in settings).
 */
export function ledgerIds(ledger: SessionLedgerEntry[]): string[] {
  return ledger.map((e) => e.id)
}

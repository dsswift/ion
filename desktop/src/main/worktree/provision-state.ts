/**
 * In-memory provisioning state, keyed by worktree path.
 *
 * ── Why memory and not disk ─────────────────────────────────────────────────
 * Provisioning state describes a run, not a fact about the worktree. After a
 * restart the honest answer is not "still building" — the process that was
 * building is gone — it is "unknown", and an unprovisioned worktree announces
 * itself the moment a command fails. Persisting `building` across a restart
 * would strand a worktree in a state nothing can ever clear.
 *
 * So a worktree with no entry here reports no state at all, and the inventory
 * omits the field. That is also exactly right for every worktree created before
 * provisioning existed.
 */
import { log as _log } from '../logger'
import { invalidateWorktreeInventoryCache } from './inventory-cache'
import type { WorktreeProvisionState } from '../../shared/types'

const TAG = 'worktree.provision'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }

interface Entry {
  state: WorktreeProvisionState
  error?: string
  /** What is being worked on right now (a seed path, or `setup`). */
  detail?: string
}

const states = new Map<string, Entry>()

/** Record a transition. Logged so the lifecycle is reconstructable from logs alone. */
export function setProvisionState(
  worktreePath: string,
  state: WorktreeProvisionState,
  detail?: string,
): void {
  const prior = states.get(worktreePath)?.state
  if (state === 'failed') {
    states.set(worktreePath, { state, error: detail })
  } else {
    states.set(worktreePath, { state, detail })
  }
  log('provision state', { worktree_path: worktreePath, from: prior ?? 'none', to: state, detail: detail ?? '' })
  // The inventory projects this state onto its rows; a cached crawl must not
  // keep reporting `building` after the run finished.
  invalidateWorktreeInventoryCache('provision state changed')
}

/** Current state, or undefined when this worktree has no provisioning record. */
export function getProvisionState(worktreePath: string): Entry | undefined {
  return states.get(worktreePath)
}

/** Drop a worktree's record — called on retire so a recreated path starts clean. */
export function clearProvisionState(worktreePath: string): void {
  if (states.delete(worktreePath)) {
    log('provision state cleared', { worktree_path: worktreePath })
  }
}

/** Test seam. */
export function _resetProvisionStatesForTests(): void {
  states.clear()
}

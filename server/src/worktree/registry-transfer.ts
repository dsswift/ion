/**
 * registry-transfer — the transfer-specific registry setter.
 *
 * Extracted from registry.ts (600-line cap) rather than added inline. Mirrors
 * `markWorktreeLanded`'s shape: load, find-or-refuse, mutate, save, invalidate
 * the inventory cache, log both branches.
 *
 * The seal setters that used to live here are gone with the sealed copy
 * itself: a transfer deletes the worktree it moved, so no registry entry
 * ever needs to record that one lives somewhere else.
 */
import { loadRegistry, saveRegistry } from './registry'
import { invalidateWorktreeInventoryCache } from './inventory-cache'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'worktree.registry.transfer'
function log(msg: string, fields?: Record<string, unknown>): void {
  _log(TAG, msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn(TAG, msg, fields)
}

/**
 * Record a worktree's resolved `repoRemote` (mirrors `settings.projects`).
 * A worktree with no registry entry cannot be attributed a remote here —
 * the caller resolves the remote from the project's OWN path, not the
 * worktree's, so a missing entry is not an error, just nothing to mirror.
 */
export function setWorktreeRepoRemote(worktreePath: string, repoRemote: string): boolean {
  const entries = loadRegistry()
  const existing = entries.find((e) => e.worktreePath === worktreePath)
  if (!existing) {
    warn('cannot set repoRemote, no registry entry', { worktree_path: worktreePath })
    return false
  }
  existing.repoRemote = repoRemote
  const saved = saveRegistry(entries)
  if (saved) {
    invalidateWorktreeInventoryCache('worktree repoRemote set')
    log('worktree repoRemote set', { worktree_path: worktreePath, repo_remote: repoRemote })
  }
  return saved
}

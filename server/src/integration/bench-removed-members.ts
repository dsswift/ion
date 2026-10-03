/**
 * Members whose worktree was removed without a retire.
 *
 * Retiring a worktree through Ion disenrolls it from every bench in the same
 * step (`disenrollWorktree`). A worktree deleted any other way (`git worktree
 * remove` in a terminal, `rm -rf`, a crashed retire) skips that step, and the
 * member stays enrolled with nothing behind it: it counts toward the bench's
 * member total, has no row to act on, and no verb can remove it.
 *
 * A missing directory is the same fact a retire records, so it gets the same
 * outcome: the member is disenrolled. The bench itself is never pruned here,
 * even when this leaves it empty. Pruning deletes the bench directory, and a
 * retire only does that after its pre-flight confirms no conversation is open
 * in the bench; nothing here can ask that question.
 */
import { existsSync } from 'fs'
import { log as _log } from '../logger'
import { findWorkspace, loadWorkspaces, saveWorkspaces } from './bench-store'
import type { IntegrationMember, IntegrationWorkspace } from '@ion/shared/types'

const TAG = 'bench.removed-members'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }

/** True when the member's worktree directory no longer exists. */
export function isWorktreeRemoved(member: Pick<IntegrationMember, 'worktreePath'>): boolean {
  return !existsSync(member.worktreePath)
}

/**
 * The bench record without the members whose worktree directory is gone,
 * logging each one dropped. Returns the record unchanged when none are. Pure
 * with respect to storage: the caller decides whether to persist.
 */
export function withoutRemovedMembers(ws: IntegrationWorkspace): IntegrationWorkspace {
  const removed = ws.members.filter(isWorktreeRemoved)
  if (removed.length === 0) return ws
  for (const member of removed) {
    log('member disenrolled: worktree removed without a retire', {
      worktree_path: member.worktreePath,
      branch: member.branchName,
      source_branch: ws.sourceBranch,
    })
  }
  const removedPaths = new Set(removed.map((m) => m.worktreePath))
  return { ...ws, members: ws.members.filter((m) => !removedPaths.has(m.worktreePath)) }
}

/**
 * Disenroll every member of one bench whose worktree directory is gone, and
 * persist. Returns the updated record, or null when there is no such bench.
 *
 * Re-reads the stored record rather than taking one, so a caller that queued
 * this behind a retire or an assembly acts on what that operation persisted.
 */
export function disenrollRemovedMembers(repoPath: string, sourceBranch: string): IntegrationWorkspace | null {
  const all = loadWorkspaces()
  const ws = findWorkspace(all, repoPath, sourceBranch)
  if (!ws) return null
  const next = withoutRemovedMembers(ws)
  if (next === ws) return ws
  saveWorkspaces(all.map((w) => (w === ws ? next : w)))
  log('removed worktrees disenrolled', {
    repo_path: repoPath,
    source_branch: sourceBranch,
    disenrolled: ws.members.length - next.members.length,
    remaining_members: next.members.length,
  })
  return next
}

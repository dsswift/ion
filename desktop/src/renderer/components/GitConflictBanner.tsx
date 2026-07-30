/**
 * GitConflictBanner — one line in the git panel when any directory of this
 * project is sitting in a conflicted operation, with the Resolve entry point.
 *
 * Reads live inventory state (worktrees with `operationState`) plus the
 * alert map (sync/land failures, which can fire before the next inventory
 * poll). Dismissing a toast does NOT hide this banner: the banner is a live
 * statement of repository state and stays until the operation completes or
 * aborts.
 */
import React, { useState } from 'react'
import { Warning } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import { ConflictsDialog } from './git/ConflictsDialog'
import { isWithinRepo } from '../../shared/repo-containment'

export function GitConflictBanner({ repoPath }: { repoPath: string }): React.JSX.Element | null {
  const colors = useColors()
  const inventory = useSessionStore((s) => s.worktreeInventory.get(repoPath))
  const alerts = useSessionStore((s) => s.gitConflictAlerts)
  const [resolving, setResolving] = useState<string | null>(null)

  // Live truth first (inventory), then alerts for directories the inventory
  // does not cover (the repo root itself, a failure before the next poll).
  const conflicted = new Map<string, string>()
  for (const wt of inventory ?? []) {
    if (wt.operationState) conflicted.set(wt.worktreePath, wt.label)
  }
  for (const [dir, alert] of alerts) {
    if (!conflicted.has(dir) && (isWithinRepo(dir, repoPath) || alert.operationState)) {
      conflicted.set(dir, alert.label ?? dir.split('/').filter(Boolean).pop() ?? dir)
    }
  }

  if (conflicted.size === 0) return null

  const [firstDir, firstLabel] = [...conflicted.entries()][0]
  const summary = conflicted.size === 1
    ? `Conflicts in ${firstLabel}`
    : `Conflicts in ${conflicted.size} directories`

  return (
    <>
      <div
        data-testid="git-panel-conflict-banner"
        style={{
          display: 'flex', alignItems: 'center', gap: 5,
          padding: '4px 10px', flexShrink: 0,
          fontSize: 10, color: colors.dangerFg,
          borderBottom: `1px solid ${colors.containerBorder}`,
        }}
      >
        <Warning size={11} />
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {summary}
        </span>
        <button
          data-testid="git-panel-conflict-resolve"
          onClick={() => setResolving(firstDir)}
          style={{
            fontSize: 10, padding: '1px 8px', borderRadius: 3, cursor: 'pointer',
            border: `1px solid ${colors.dangerFg}`, background: 'transparent', color: colors.dangerFg,
          }}
        >
          Resolve
        </button>
      </div>

      {resolving && (
        <ConflictsDialog directory={resolving} onClose={() => setResolving(null)} />
      )}
    </>
  )
}

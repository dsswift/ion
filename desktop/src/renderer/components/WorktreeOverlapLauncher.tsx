import React from 'react'
import { Intersect } from '@phosphor-icons/react'
import { Tooltip } from './git/Tooltip'
import { useColors } from '../theme'

export function WorktreeOverlapLauncher({ repoPath, sourceBranch }: { repoPath: string; sourceBranch?: string }): React.JSX.Element | null {
  const colors = useColors()
  if (!repoPath || repoPath === '~') return null
  return <Tooltip text="Open graphical worktree overlap analysis">
    <button
      data-testid="worktree-overlap-launcher"
      aria-label="Open worktree overlap analysis"
      onClick={() => window.ion.openWorktreeOverlap({ repoPath, sourceBranch })}
      style={{ display: 'inline-flex', padding: 2, border: 'none', borderRadius: 4, background: 'transparent', color: colors.textTertiary, cursor: 'pointer' }}
    >
      <Intersect size={12} />
    </button>
  </Tooltip>
}

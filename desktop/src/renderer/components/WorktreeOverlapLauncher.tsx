import React from 'react'
import { Intersect } from '@phosphor-icons/react'
import { Tooltip } from './git/Tooltip'
import { useColors } from '../theme'
import { host } from '../host/host-instance'

export function WorktreeOverlapLauncher({ repoPath, sourceBranch }: { repoPath: string; sourceBranch?: string }): React.JSX.Element | null {
  const colors = useColors()
  if (!repoPath || repoPath === '~') return null
  // `openWorktreeOverlap` opens a separate native Electron window (its own
  // renderer entry point, `worktree-overlap.html`), so the gate is
  // `nativeShell` — the capability for "this client has an OS shell". It used
  // to reuse a git-flavoured gate on the reasoning that this is a git tool,
  // but git is bridged on every host, so that gate opened and the call threw.
  // What is missing in a browser is the window, not the git.
  if (!host.capabilities().includes('nativeShell')) return null
  return <Tooltip text="Open graphical worktree overlap analysis">
    <button
      data-testid="worktree-overlap-launcher"
      aria-label="Open worktree overlap analysis"
      onClick={() => host.shell.openWorktreeOverlap({ repoPath, sourceBranch })}
      style={{ display: 'inline-flex', padding: 2, border: 'none', borderRadius: 4, background: 'transparent', color: colors.textTertiary, cursor: 'pointer' }}
    >
      <Intersect size={12} />
    </button>
  </Tooltip>
}

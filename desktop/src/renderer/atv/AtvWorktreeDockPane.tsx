/**
 * AtvWorktreeDockPane — the worktree console inside the ATV dock.
 *
 * Mounts the OVERLAY's components (`WorktreesSection`, `IntegrationSection`) on
 * the mirror store rather than reimplementing them. Parity mechanism 1: a
 * shared surface is one component, one store. A bespoke ATV widget here would
 * be a second implementation of the pin/staleness vocabulary, free to drift
 * from the overlay's.
 *
 * The dock has no git panel, so this pane supplies the section chrome the panel
 * would otherwise provide, and resolves the repo root the same way: through the
 * active tab's worktree metadata when it is a worktree, else its directory.
 */
import React, { useMemo } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import { WorktreesSection } from '../components/WorktreesSection'
import { IntegrationSection } from '../components/IntegrationSection'

export function AtvWorktreeDockPane(): React.JSX.Element {
  const colors = useColors()
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const tab = useSessionStore((s) => s.tabs.find((t) => t.id === s.activeTabId))

  // A worktree's worktrees belong to its PARENT repo, not to the worktree
  // directory -- resolve through the worktree metadata when present.
  const repoPath = useMemo(
    () => tab?.worktree?.repoPath ?? tab?.workingDirectory ?? '',
    [tab?.worktree?.repoPath, tab?.workingDirectory],
  )

  if (!repoPath || repoPath === '~') {
    return (
      <div style={{ padding: 16, color: colors.textTertiary, fontSize: 12 }}>
        No project directory for the active conversation.
      </div>
    )
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
      <SectionHeading label="Worktrees" colors={colors} />
      <WorktreesSection repoPath={repoPath} refreshKey={activeTabId ? 1 : 0} />
      <SectionHeading label="Integration" colors={colors} />
      <IntegrationSection repoPath={repoPath} refreshKey={activeTabId ? 1 : 0} />
    </div>
  )
}

function SectionHeading({ label, colors }: { label: string; colors: ReturnType<typeof useColors> }): React.JSX.Element {
  return (
    <div
      style={{
        padding: '6px 10px 4px',
        fontSize: 11,
        fontWeight: 600,
        color: colors.textSecondary,
        borderBottom: `1px solid ${colors.containerBorder}`,
        background: colors.surfacePrimary,
      }}
    >
      {label}
    </div>
  )
}

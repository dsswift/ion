/**
 * AtvWorktreeDockPane — the worktree console inside the ATV dock.
 *
 * Mounts the OVERLAY's `WorktreeListSection` on the mirror store rather than
 * reimplementing it. Parity mechanism 1: a shared surface is one component, one
 * store. A bespoke ATV widget here would be a second implementation of the
 * pin/staleness vocabulary, free to drift from the overlay's.
 *
 * One section, not two: worktrees and bench members were the same object shown
 * twice, so the bench is now the enrolled subset of the single list and its
 * bar rides above those rows.
 *
 * The dock has no git panel, so this pane supplies the section chrome the panel
 * would otherwise provide, and resolves the repo root the same way: through the
 * active tab's worktree metadata when it is a worktree, else its directory.
 */
import React, { useMemo } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import { WorktreeListSection } from '../components/WorktreeListSection'

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
    // `overflow: hidden`, not `overflowY: auto`: both sections now grow to fill
    // the space they are given and scroll themselves, so an outer scroller would
    // fight them — the column would stretch to its content and neither section
    // would ever reach its own scroll threshold. Same shape as the overlay's git
    // panel, where each pane body clips and the section inside it scrolls.
    <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <SectionHeading label="Worktrees" colors={colors} />
      <WorktreeListSection repoPath={repoPath} refreshKey={activeTabId ? 1 : 0} />
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
        // The two sections below grow; the headings must not, or they would
        // give up their height to them.
        flexShrink: 0,
      }}
    >
      {label}
    </div>
  )
}

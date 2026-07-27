/**
 * WorktreeRow — one worktree, rendered identically everywhere it appears.
 *
 * Used by the git-panel Worktrees section, the new-tab picker group, and the ATV
 * mount. One component so the state vocabulary (dirty dot, unlanded count,
 * stale-base indicator) cannot drift between surfaces.
 *
 * Clicking the row OPENS OR FOCUSES a conversation in the worktree. That is the
 * re-entry path: closing a worktree tab no longer destroys anything, so the
 * operator needs a way back in without knowing the `~/.ion/worktrees/...` path.
 */
import React from 'react'
import { ArrowsClockwise, CircleNotch, DotsThree } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { Tooltip } from './git/Tooltip'
import type { WorktreeInventoryEntry } from '../../shared/types'

export interface WorktreeRowProps {
  entry: WorktreeInventoryEntry
  /** Id of a tab already open on this worktree, when one exists. */
  openTabId?: string
  /** 1-based display index of that tab, for the "open in tab 3" hint. */
  openTabIndex?: number
  /** True while a sync is in flight for this worktree. */
  syncing?: boolean
  onOpen(): void
  onSync(): void
  onMenu(anchor: { x: number; y: number }): void
}

export function WorktreeRow(props: WorktreeRowProps): React.JSX.Element {
  const colors = useColors()
  const { entry, openTabId, openTabIndex, syncing } = props

  // Dirty state as a filled/hollow dot: the most glanceable signal, and the one
  // that tells the operator whether walking away costs anything.
  const dotColor = entry.isDirty ? colors.worktreeGreen : colors.textTertiary

  return (
    <div
      data-ion-ui
      data-testid={`worktree-row-${entry.branchName}`}
      onClick={props.onOpen}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        props.onMenu({ x: e.clientX, y: e.clientY })
      }}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        padding: '3px 6px',
        borderRadius: 4,
        cursor: 'pointer',
        userSelect: 'none',
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = colors.surfaceHover }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <Tooltip text={entry.isDirty ? 'Uncommitted changes' : 'Clean'}>
          <span
            data-testid={`worktree-dirty-${entry.branchName}`}
            style={{
              width: 6, height: 6, borderRadius: 3, flexShrink: 0,
              background: entry.isDirty ? dotColor : 'transparent',
              border: `1px solid ${dotColor}`,
            }}
          />
        </Tooltip>

        <span style={{ fontSize: 11, color: colors.textPrimary, fontWeight: 500, flexShrink: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {entry.label}
        </span>
        <span style={{ fontSize: 9, color: colors.textTertiary, flexShrink: 0 }}>
          {entry.branchName}
        </span>

        <span style={{ flex: 1 }} />

        {/* Unlanded commits: what this worktree is holding that the feature
            branch does not have yet. */}
        {entry.unlandedCommitCount > 0 && (
          <Tooltip text={`${entry.unlandedCommitCount} commit${entry.unlandedCommitCount === 1 ? '' : 's'} not yet landed`}>
            <span
              data-testid={`worktree-unlanded-${entry.branchName}`}
              style={{ fontSize: 9, color: colors.worktreeGreen, flexShrink: 0 }}
            >
              {entry.unlandedCommitCount}↑
            </span>
          </Tooltip>
        )}

        {/* Base staleness: the feature branch moved ahead and a sync would
            genuinely change this worktree. Never shown when a sync would be a
            no-op -- a badge nothing can clear teaches the operator to ignore
            all badges. */}
        {entry.needsSync && (
          <Tooltip text={entry.sourceBranch
            ? `Base moved: sync from ${entry.sourceBranch}`
            : 'Base moved'}>
            <button
              data-testid={`worktree-sync-${entry.branchName}`}
              onClick={(e) => { e.stopPropagation(); props.onSync() }}
              disabled={syncing}
              style={{
                display: 'inline-flex', alignItems: 'center', padding: 0,
                background: 'transparent', border: 'none',
                color: colors.warningFg, cursor: syncing ? 'default' : 'pointer', flexShrink: 0,
              }}
            >
              {syncing
                ? <CircleNotch size={11} className="animate-spin" />
                : <ArrowsClockwise size={11} />}
            </button>
          </Tooltip>
        )}

        <button
          data-testid={`worktree-menu-${entry.branchName}`}
          onClick={(e) => {
            e.stopPropagation()
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
            props.onMenu({ x: r.left, y: r.bottom })
          }}
          style={{
            display: 'inline-flex', alignItems: 'center', padding: 0,
            background: 'transparent', border: 'none', color: colors.textTertiary,
            cursor: 'pointer', flexShrink: 0,
          }}
        >
          <DotsThree size={12} />
        </button>
      </div>

      {/* Second line: the last commit subject tells worktrees apart far better
          than a generated `wt/a3f1` branch name does. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, paddingLeft: 11 }}>
        <span style={{ fontSize: 9, color: colors.textTertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 1, minWidth: 0 }}>
          {entry.lastCommitSubject || 'no commits yet'}
        </span>
        {/* Open-or-focus: without this hint the operator creates a second
            conversation in a worktree that already has one. */}
        {openTabId && (
          <span style={{ fontSize: 9, color: colors.accent, flexShrink: 0 }}>
            {openTabIndex ? `open in tab ${openTabIndex}` : 'open'}
          </span>
        )}
        {!entry.sourceBranch && (
          <Tooltip text="Ion did not create this worktree, so its source branch is unknown. Land and sync will ask.">
            <span
              data-testid={`worktree-unknown-source-${entry.branchName}`}
              style={{ fontSize: 9, color: colors.textTertiary, flexShrink: 0, fontStyle: 'italic' }}
            >
              source unknown
            </span>
          </Tooltip>
        )}
      </div>
    </div>
  )
}

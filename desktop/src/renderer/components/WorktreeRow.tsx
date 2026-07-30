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
import { ArrowsClockwise, CircleNotch, DotsThree, Warning } from '@phosphor-icons/react'
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
  /** Open the conflict-resolution dialog. Offered when `operationState` is set. */
  onResolve?(): void
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

        {/* ONE identifier. The branch is `wt/<label>` by construction (see
            GIT_WORKTREE_ADD), so printing both was redundant — and worse, the
            two used to be unrelated random hex, which made the prominent text
            useless for finding the branch every git verb actually names. */}
        <Tooltip text={`Branch ${entry.branchName}`}>
          <span style={{ fontSize: 11, color: colors.textPrimary, fontWeight: 500, flexShrink: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {entry.label}
          </span>
        </Tooltip>

        {/* Open-or-focus sits next to the name it qualifies. On the second line
            it read as an attribute of the commit subject rather than of the
            worktree. */}
        {openTabId && (
          <span
            data-testid={`worktree-open-${entry.branchName}`}
            style={{ fontSize: 9, color: colors.accent, flexShrink: 0 }}
          >
            {openTabIndex ? `open in tab ${openTabIndex}` : 'open'}
          </span>
        )}

        <span style={{ flex: 1 }} />

        {/* An in-progress conflicted operation outranks every other badge: the
            worktree is mid-rebase, its other numbers are meaningless, and the
            one useful action is Resolve. This used to be invisible — the
            worktree simply vanished from the list mid-rebase. */}
        {entry.operationState && (
          <Tooltip text={`A ${entry.operationState === 'rebasing' ? 'rebase' : entry.operationState === 'merging' ? 'merge' : 'cherry-pick'} is in progress${(entry.conflictedPaths?.length ?? 0) > 0 ? ` with ${entry.conflictedPaths!.length} conflicted file${entry.conflictedPaths!.length === 1 ? '' : 's'}` : ''}. Click to resolve.`}>
            <button
              data-testid={`worktree-conflict-${entry.branchName}`}
              onClick={(e) => { e.stopPropagation(); props.onResolve?.() }}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 3,
                fontSize: 9, padding: '1px 6px', borderRadius: 3, flexShrink: 0,
                border: `1px solid ${colors.dangerFg}`, background: 'transparent',
                color: colors.dangerFg, cursor: 'pointer',
              }}
            >
              <Warning size={9} /> conflict · Resolve
            </button>
          </Tooltip>
        )}

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
            all badges.

            A DIRTY worktree cannot sync (the verb refuses rather than rebasing
            over uncommitted work), so the affordance says that up front: the
            icon renders in the disabled colour with the remediation in its
            tooltip. Clicking still fires the sync — the refusal toast carries
            the same message — but the row no longer looks like a working
            button that silently does nothing. */}
        {entry.needsSync && (
          <Tooltip text={entry.isDirty
            ? 'Base moved, but this worktree has uncommitted changes. Commit or stash them, then sync.'
            : entry.sourceBranch
              ? `Base moved: sync from ${entry.sourceBranch}`
              : 'Base moved'}>
            <button
              data-testid={`worktree-sync-${entry.branchName}`}
              onClick={(e) => { e.stopPropagation(); props.onSync() }}
              disabled={syncing}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 2, padding: 0,
                background: 'transparent', border: 'none',
                color: entry.isDirty ? colors.textTertiary : colors.warningFg,
                cursor: syncing ? 'default' : 'pointer', flexShrink: 0,
              }}
            >
              {syncing
                ? <CircleNotch size={11} className="animate-spin" />
                : <ArrowsClockwise size={11} />}
              {entry.isDirty && !syncing && (
                <span data-testid={`worktree-sync-blocked-${entry.branchName}`} style={{ fontSize: 8 }}>
                  blocked
                </span>
              )}
            </button>
          </Tooltip>
        )}

        {/* Provisioning: the gitignored dependency state a checkout needs but
            git never carries (node_modules, hooks, build caches). Shown only
            while it is in flight or has failed -- a `ready` worktree is the
            normal case and needs no badge, and a worktree with no provisioning
            record at all (created before this existed) shows nothing rather
            than claiming a state Ion cannot know. */}
        {(entry.provisionState === 'seeding' || entry.provisionState === 'building' || entry.provisionState === 'probing') && (
          <Tooltip text="Installing dependencies for this worktree">
            <span
              data-testid={`worktree-provisioning-${entry.branchName}`}
              style={{ display: 'inline-flex', alignItems: 'center', color: colors.textTertiary, flexShrink: 0 }}
            >
              <CircleNotch size={11} className="animate-spin" />
            </span>
          </Tooltip>
        )}
        {entry.provisionState === 'failed' && (
          <Tooltip text={entry.provisionError
            ? `Dependency setup failed: ${entry.provisionError}`
            : 'Dependency setup failed. Use Re-provision in the row menu.'}>
            <span
              data-testid={`worktree-provision-failed-${entry.branchName}`}
              style={{ display: 'inline-flex', alignItems: 'center', color: colors.dangerFg, flexShrink: 0 }}
            >
              <Warning size={11} />
            </span>
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
          than a generated slug does. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, paddingLeft: 11 }}>
        <span style={{ fontSize: 9, color: colors.textTertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 1, minWidth: 0 }}>
          {entry.lastCommitSubject || 'no commits yet'}
        </span>
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

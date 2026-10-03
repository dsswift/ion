import { useActiveDeveloperSurfaces } from '../../studio/connection/developer-surfaces'
import React from 'react'
import { isWorktreeSealed } from '@ion/shared/worktree-seal'
import {
  ArrowsClockwise, ArrowDown, ArrowUp, CheckCircle, SpinnerGap,
} from '@phosphor-icons/react'
import { Tooltip } from './Tooltip'
import { useSessionStore } from '@ion/server/store/sessionStore'
import { useColors } from '../../theme'
import { BranchPicker } from '../GitBranchPicker'
import { rError } from '../../rendererLogger'

/**
 * Header row for GitGraphSection: branch picker plus fetch/pull/push/finish
 * controls. Split out purely to keep GitGraphSection.tsx under the 600-line
 * cap -- no behavior of its own beyond what GitGraphSection already had.
 */
export function GitGraphToolbar({
  directory,
  branch,
  worktree,
  hasUncommittedChanges,
  activeTabId,
  strategy,
  pushConfirm,
  setPushConfirm,
  fetchingAction,
  handleFetch,
  handlePull,
  handlePush,
  handleBranchRefresh,
  setFinishMenuAnchor,
}: {
  directory: string
  branch: string
  worktree?: { branchName: string; sourceBranch: string; worktreePath: string; repoPath: string; landedAt?: number } | null
  hasUncommittedChanges: boolean
  activeTabId: string
  strategy: string
  pushConfirm: boolean
  setPushConfirm: (v: boolean) => void
  fetchingAction: string | null
  handleFetch: () => Promise<void>
  handlePull: () => Promise<void>
  handlePush: () => Promise<void>
  handleBranchRefresh: () => void
  setFinishMenuAnchor: (anchor: { x: number; y: number } | null) => void
}): React.JSX.Element {
  const colors = useColors()
  // Every control in this bar writes to the repository, so the bar is bare
  // where source control is off: the graph below it stays readable.
  const { sourceControl, repositoryStatus, worktrees: worktreesOffered } = useActiveDeveloperSurfaces()
  return (
    <div
      className="flex items-center justify-between px-2"
      style={{ height: 24, borderBottom: `1px solid ${colors.containerBorder}` }}
    >
      {sourceControl ? (
        <BranchPicker directory={directory} currentBranch={branch} onRefresh={handleBranchRefresh} worktree={worktree} />
      ) : (
        <span className="text-[10px]" style={{ color: colors.textTertiary }}>{repositoryStatus ? branch : ''}</span>
      )}
      <div className="flex items-center gap-0.5">
        {!sourceControl ? null : pushConfirm ? (
          <div className="flex items-center gap-0.5 text-[9px]">
            <span style={{ color: colors.textTertiary }}>Push?</span>
            <button
              onClick={() => { void handlePush().catch((err) => rError('git', 'push failed', { error: String(err) })) }}
              className="px-1 rounded"
              style={{ color: colors.accent }}
            >
              Yes
            </button>
            <button
              onClick={() => setPushConfirm(false)}
              className="px-1 rounded"
              style={{ color: colors.textTertiary }}
            >
              No
            </button>
          </div>
        ) : (
          <>
            <Tooltip text="Fetch">
              <button
                onClick={() => { void handleFetch().catch((err) => rError('git', 'fetch failed', { error: String(err) })) }}
                disabled={!!fetchingAction}
                className="p-0.5 rounded transition-colors"
                style={{ color: colors.textTertiary }}
              >
                {fetchingAction === 'fetch' ? <SpinnerGap size={11} className="animate-spin" /> : <ArrowsClockwise size={11} />}
              </button>
            </Tooltip>
            <Tooltip text={worktree ? `Rebase from ${worktree.sourceBranch}` : 'Pull'}>
              <button
                onClick={() => { void handlePull().catch((err) => rError('git', 'pull failed', { error: String(err) })) }}
                disabled={!!fetchingAction}
                className="p-0.5 rounded transition-colors"
                style={{ color: colors.textTertiary }}
              >
                {fetchingAction === 'pull' ? <SpinnerGap size={11} className="animate-spin" /> : <ArrowDown size={11} />}
              </button>
            </Tooltip>
            {worktree && !worktreesOffered ? null : worktree && !isWorktreeSealed(worktree) ? (
              <Tooltip text={hasUncommittedChanges
                  ? 'Commit all changes before finishing'
                  : strategy === 'merge-ff'
                    ? `Finish: fast-forward into ${worktree.sourceBranch}`
                    : strategy === 'merge'
                    ? `Finish: merge into ${worktree.sourceBranch}`
                    : `Finish: push and create PR against ${worktree.sourceBranch}`}>
                <button
                  onClick={() => {
                    if (!hasUncommittedChanges) {
                      useSessionStore.getState().finishWorktreeTab(activeTabId)
                        .catch((err) => rError('git', 'finishWorktreeTab failed', { error: String(err) }))
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    if (!hasUncommittedChanges) {
                      setFinishMenuAnchor({ x: e.clientX, y: e.clientY })
                    }
                  }}
                  disabled={hasUncommittedChanges}
                  className="p-0.5 rounded transition-colors"
                  style={{
                    color: hasUncommittedChanges ? colors.textTertiary : colors.worktreeGreen,
                    opacity: hasUncommittedChanges ? 0.35 : 1,
                    cursor: hasUncommittedChanges ? 'not-allowed' : 'pointer',
                  }}
                >
                  <CheckCircle size={11} weight="fill" />
                </button>
              </Tooltip>
            ) : worktree?.landedAt ? null : (
              <Tooltip text="Push">
                <button
                  onClick={() => { void handlePush().catch((err) => rError('git', 'push failed', { error: String(err) })) }}
                  disabled={!!fetchingAction}
                  className="p-0.5 rounded transition-colors"
                  style={{ color: colors.textTertiary }}
                >
                  {fetchingAction === 'push' ? <SpinnerGap size={11} className="animate-spin" /> : <ArrowUp size={11} />}
                </button>
              </Tooltip>
            )}
          </>
        )}
      </div>
    </div>
  )
}

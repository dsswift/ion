/**
 * WorktreePipelinePanel — the sync-all pipeline's one surface in the git
 * panel: the "Sync all" verb, the live progress banner, the AI confirm gate,
 * and the terminal summary.
 *
 * Renders between the BenchBar and the worktree rows. The verb appears only
 * when it has something to do (a row needs sync or sits mid-operation); the
 * banner replaces it while the pipeline runs so the two can never show
 * conflicting stories. All state lives in the store's `worktreePipeline` slot
 * (never component state) — the ATV mirror renders the same banner from the
 * same record, and every button dispatches a FORWARDED store action.
 *
 * The confirm gate is the cost-visibility stop: agents cost real money, so
 * the dialog names every worktree an agent would be launched for and says the
 * launches are sequential (one at a time, with recorded-resolution replay
 * between them — the reason sequential is cheaper than parallel).
 */
import React from 'react'
import { ArrowsClockwise, CheckCircle, CircleNotch, Warning, X } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import { Tooltip } from './git/Tooltip'
import { ConfirmDialog } from './git/ConfirmDialog'
import { rError } from '../rendererLogger'
import type { WorktreeInventoryEntry } from '../../shared/types'
import type { WorktreePipelineState } from '../stores/session-store-types'

/** Display name for a worktree path within the pipeline's outcome list. */
function nameOf(p: WorktreePipelineState, worktreePath: string): string {
  const o = p.outcomes.find((x) => x.worktreePath === worktreePath)
  return o?.title || o?.branchName || worktreePath.split('/').filter(Boolean).pop() || worktreePath
}

/** The running phases, for the banner's one-line description. */
function phaseLabel(p: WorktreePipelineState): string {
  switch (p.phase) {
    case 'syncing': return 'Syncing worktrees from source…'
    case 'awaiting-ai-confirm': return 'Waiting for confirmation'
    case 'resolving': {
      const total = p.queue.length + p.resolvedByAi + p.needsManual.length
      const done = p.resolvedByAi + p.needsManual.length
      const current = p.current ? nameOf(p, p.current) : null
      return current
        ? `Resolving ${current} (${Math.min(done + 1, total)}/${total})…`
        : `Resolving conflicts (${done}/${total})…`
    }
    case 'assembling': return 'Updating bench…'
    case 'done': return p.summary ?? 'Done'
    case 'failed': return p.summary ?? 'Failed'
  }
}

export function WorktreePipelinePanel({
  repoPath,
  sourceBranch,
  entries,
}: {
  repoPath: string
  /** The active bench's source branch, when one exists — enables phase 4. */
  sourceBranch: string | null
  entries: readonly WorktreeInventoryEntry[]
}): React.JSX.Element | null {
  const colors = useColors()
  const pipeline = useSessionStore((s) => s.worktreePipeline)

  // The verb has work when any row is base-stale or stuck mid-operation.
  // Dirty-but-stale rows still count: the pass reports them as skipped, which
  // is itself the answer the operator needs ("why didn't it sync? dirty").
  const actionable = entries.filter((e) => e.needsSync || e.operationState).length

  const mine = pipeline && pipeline.repoPath === repoPath ? pipeline : null
  const running = mine && mine.phase !== 'done' && mine.phase !== 'failed'
  const otherRepoBusy = !!pipeline && pipeline.repoPath !== repoPath
    && pipeline.phase !== 'done' && pipeline.phase !== 'failed'

  // Nothing to show: no runnable work, nothing running, nothing to report.
  if (!mine && actionable === 0) return null

  const conflictedNames = mine?.phase === 'awaiting-ai-confirm'
    ? mine.queue.map((wt) => nameOf(mine, wt))
    : []

  return (
    <div style={{ flexShrink: 0 }}>
      {!running && actionable > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 6px' }}>
          <Tooltip text={otherRepoBusy
            ? 'A sync pipeline is already running for another project'
            : 'Sync every worktree from its source branch. Conflicts already resolved once complete automatically; anything new pauses for confirmation before AI resolution.'}
          >
            <button
              data-testid="worktree-sync-all"
              disabled={otherRepoBusy}
              onClick={() => {
                void useSessionStore.getState()
                  .startWorktreePipeline(repoPath, sourceBranch)
                  .catch((err) => rError('worktree.pipeline', 'start failed', { error: String(err) }))
              }}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                fontSize: 10, padding: '2px 8px', borderRadius: 3,
                cursor: otherRepoBusy ? 'default' : 'pointer',
                border: `1px solid ${colors.accent}`,
                background: colors.accentLight, color: colors.accent,
                opacity: otherRepoBusy ? 0.5 : 1,
              }}
            >
              <ArrowsClockwise size={10} />
              Sync all · {actionable}
            </button>
          </Tooltip>
        </div>
      )}

      {mine && (
        <div
          data-testid="worktree-pipeline-banner"
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '4px 8px', fontSize: 10,
            color: mine.phase === 'failed' ? colors.dangerFg : colors.textSecondary,
          }}
        >
          {running
            ? <CircleNotch size={11} className="animate-spin" style={{ flexShrink: 0, color: colors.accent }} />
            : mine.phase === 'failed' || mine.needsManual.length > 0
              ? <Warning size={11} style={{ flexShrink: 0, color: mine.phase === 'failed' ? colors.dangerFg : colors.warningFg }} />
              : <CheckCircle size={11} style={{ flexShrink: 0, color: colors.worktreeGreen }} />}
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {phaseLabel(mine)}
          </span>
          {running && mine.phase !== 'awaiting-ai-confirm' && (
            <Tooltip text="Stop after the current step. Running rebases and agents are never interrupted.">
              <button
                data-testid="worktree-pipeline-cancel"
                onClick={() => useSessionStore.getState().cancelWorktreePipeline()}
                disabled={mine.cancelled}
                style={{
                  fontSize: 9, padding: '1px 6px', borderRadius: 3,
                  cursor: mine.cancelled ? 'default' : 'pointer',
                  border: `1px solid ${colors.containerBorder}`,
                  background: 'transparent', color: colors.textSecondary,
                  opacity: mine.cancelled ? 0.5 : 1, flexShrink: 0,
                }}
              >
                {mine.cancelled ? 'Stopping…' : 'Cancel'}
              </button>
            </Tooltip>
          )}
          {!running && (
            <button
              data-testid="worktree-pipeline-dismiss"
              onClick={() => useSessionStore.getState().dismissWorktreePipeline()}
              style={{
                display: 'inline-flex', alignItems: 'center', padding: 1,
                background: 'transparent', border: 'none',
                color: colors.textTertiary, cursor: 'pointer', flexShrink: 0,
              }}
            >
              <X size={10} />
            </button>
          )}
        </div>
      )}

      {mine?.phase === 'awaiting-ai-confirm' && (
        <ConfirmDialog
          title={`Resolve ${conflictedNames.length} conflict${conflictedNames.length === 1 ? '' : 's'} with AI?`}
          message={
            `Still conflicted after sync: ${conflictedNames.join(', ')}. ` +
            'One agent runs at a time; each resolution is recorded and replayed ' +
            'into the remaining worktrees, so later conflicts may resolve without an agent.'
          }
          confirmLabel="Launch AI resolution"
          onConfirm={() => {
            void useSessionStore.getState()
              .confirmWorktreePipelineAi()
              .catch((err) => rError('worktree.pipeline', 'confirm failed', { error: String(err) }))
          }}
          onCancel={() => useSessionStore.getState().cancelWorktreePipeline()}
        />
      )}
    </div>
  )
}

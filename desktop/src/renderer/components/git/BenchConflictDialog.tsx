/**
 * BenchConflictDialog — what a bench merge conflict IS, and the two ways out.
 *
 * ── Why this is not the ConflictsDialog ─────────────────────────────────────
 * A bench conflict is not an in-progress git operation. The failed assembly
 * aborted its merge and wiped the bench (atomicity), so at the moment this
 * dialog opens there is nothing conflicted on disk — the evidence lives in the
 * MEMBERSHIP RECORD (`conflictPaths` / `conflictsWith`), which is why this
 * reads the store synchronously and runs no IPC probe (view-readiness: correct
 * the moment it renders). The badge used to open the ConflictsDialog on the
 * bench directory, which probed for an operation that could not exist: an
 * empty file list, a disabled Abort, and an operator who reasonably concluded
 * the alert was broken.
 *
 * ── The two verbs ───────────────────────────────────────────────────────────
 * - **Resolve once**: `benchResolveConflict` re-creates the failed merge in
 *   the bench and leaves it in progress; the caller then opens the REAL
 *   ConflictsDialog on it. Completing that merge records the resolution
 *   (git rerere), and every later assembly replays it — resolve once, replay
 *   forever, until either side's lines genuinely change.
 * - **Open the member worktree**: the durable fix. Rework the collision in the
 *   worktree that owns it, commit there, Update the pin, reassemble.
 */
import React, { useState } from 'react'
import { ArrowsClockwise, ChatCircle, Warning } from '@phosphor-icons/react'
import { useColors } from '../../theme'
import { FloatingPanel } from '../FloatingPanel'
import { useSessionStore } from '../../stores/sessionStore'
import { rError, rInfo } from '../../rendererLogger'
import type { IntegrationMember } from '../../../shared/types'

export function BenchConflictDialog({
  repoPath,
  sourceBranch,
  member,
  onClose,
  onResolveReady,
}: {
  repoPath: string
  sourceBranch: string
  /** The conflicted membership record — the dialog's whole read model. */
  member: IntegrationMember
  onClose: () => void
  /** A merge is now in progress in the bench: open the ConflictsDialog there. */
  onResolveReady: (benchPath: string) => void
}): React.JSX.Element {
  const colors = useColors()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'resolve' | 'open' | null>(null)

  const paths = member.conflictPaths ?? []
  const colliders = member.conflictsWith ?? []

  const resolveOnce = (): void => {
    setBusy('resolve')
    void useSessionStore.getState()
      .benchResolveConflict(repoPath, sourceBranch)
      .then((benchPath) => {
        if (benchPath) {
          rInfo('bench.conflict', 'resolution merge prepared, opening resolver', { bench_path: benchPath })
          onResolveReady(benchPath)
        } else {
          // Recordings already covered it and the store reassembled — the
          // conflict no longer exists, so there is nothing to show.
          rInfo('bench.conflict', 'nothing left to resolve, closed', { source_branch: sourceBranch })
          onClose()
        }
      })
      .catch((err) => {
        rError('bench.conflict', 'resolve preparation failed', { error: String(err) })
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => setBusy(null))
  }

  const openWorktree = (): void => {
    setBusy('open')
    void useSessionStore.getState()
      .openWorktreeConversation(member.worktreePath)
      .then(() => onClose())
      .catch((err) => {
        rError('bench.conflict', 'open member worktree failed', { error: String(err) })
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => setBusy(null))
  }

  return (
    <FloatingPanel
      title={`Bench conflict — ${member.branchName}`}
      onClose={onClose}
      defaultWidth={560}
      defaultHeight={360}
      workingDir={member.worktreePath}
    >
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        {error && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '6px 10px', fontSize: 11, color: colors.dangerFg }}>
            <Warning size={12} /> {error}
          </div>
        )}

        <div style={{ padding: '8px 10px', fontSize: 11, color: colors.textPrimary, lineHeight: 1.5 }}>
          The last assembly could not merge <strong>{member.branchName}</strong>
          {colliders.length > 0
            ? <> — it collides with <strong>{colliders.join(', ')}</strong>.</>
            : <> — it collides with the bench&apos;s base branch ({sourceBranch}).</>}
          {' '}The bench was left empty: it presents the whole enrolled combination or nothing,
          so there is no partial build to mislead testing.
        </div>

        <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
          {paths.length === 0 && (
            <div style={{ padding: '4px 12px', fontSize: 11, color: colors.textSecondary }}>
              The conflicting files could not be listed. Resolve once to see them in the merge view.
            </div>
          )}
          {paths.map((p) => (
            <div
              key={p}
              data-testid={`bench-conflict-path-${p}`}
              style={{
                padding: '4px 12px', fontSize: 11, fontFamily: 'monospace',
                color: colors.textPrimary, borderBottom: `1px solid ${colors.containerBorder}`,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
            >
              {p}
            </div>
          ))}
        </div>

        <div style={{ padding: '6px 10px', fontSize: 10, color: colors.textSecondary, lineHeight: 1.5 }}>
          Resolve once opens a real merge in the bench; the resolution is recorded and replayed by
          every future assembly until either side changes those lines. The durable fix is to rework
          the collision in the member worktree, commit there, then Update and reassemble.
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderTop: `1px solid ${colors.containerBorder}` }}>
          <button
            data-testid="bench-conflict-resolve"
            onClick={resolveOnce}
            disabled={busy !== null}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              fontSize: 11, padding: '3px 10px', borderRadius: 4, cursor: 'pointer',
              border: `1px solid ${colors.accent}`, background: colors.accentLight, color: colors.accent,
            }}
          >
            {busy === 'resolve' ? <ArrowsClockwise size={12} className="animate-spin" /> : null}
            Resolve once
          </button>
          <button
            data-testid="bench-conflict-open-worktree"
            onClick={openWorktree}
            disabled={busy !== null}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              fontSize: 11, padding: '3px 10px', borderRadius: 4, cursor: 'pointer',
              border: `1px solid ${colors.containerBorder}`, background: 'transparent', color: colors.textPrimary,
            }}
          >
            <ChatCircle size={12} /> Open {member.branchName}
          </button>
          <span style={{ flex: 1 }} />
          <button
            data-testid="bench-conflict-close"
            onClick={onClose}
            style={{
              fontSize: 11, padding: '3px 8px', borderRadius: 4, cursor: 'pointer',
              border: `1px solid ${colors.containerBorder}`, background: 'transparent', color: colors.textSecondary,
            }}
          >
            Close
          </button>
        </div>
      </div>
    </FloatingPanel>
  )
}

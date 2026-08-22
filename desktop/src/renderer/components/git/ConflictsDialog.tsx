/**
 * ConflictsDialog — the JetBrains-style "Conflicts" list for one directory.
 *
 * Opened by any Resolve action (worktree row badge, git-panel banner, merge
 * section). One row per conflicted file with its shape (both modified, both
 * added, delete/modify), resolved wholesale via Accept Yours / Accept Theirs
 * or interactively via the 3-way MergeEditor. The footer carries the
 * operation-level verbs: AI Assisted (a conversation in the directory with the
 * fixed rebase-fix prompt), Abort, and Continue — Continue lights up only when
 * nothing is left unmerged.
 *
 * "Yours"/"Theirs" are never shown as bare git-speak: during a rebase git
 * swaps the sides (stage 2 is the branch rebased ONTO), which is exactly the
 * confusion this dialog exists to remove. The main process resolves labels
 * from the operation state and every button names the branch.
 *
 * ── Continue can re-conflict ────────────────────────────────────────────────
 * A multi-commit rebase does not end when the currently-visible conflict
 * clears: Continue commits that step and git keeps applying the remaining
 * todo, which can stop again on a brand-new conflict several commits later.
 * A failed Continue/Abort result therefore always re-probes GIT_OP_STATE (see
 * `runFooter`) so `op` reflects whatever is ACTUALLY unmerged now, rather than
 * leaving the stale "all resolved" state from the step that just finished
 * sitting underneath the fresh failure message.
 */
import React, { useCallback, useEffect, useState } from 'react'
import { ArrowsClockwise, Robot, Warning, X } from '@phosphor-icons/react'
import { useColors } from '../../theme'
import { FloatingPanel } from '../FloatingPanel'
import { ConfirmDialog } from './ConfirmDialog'
import { MergeEditor } from './MergeEditor'
import { useSessionStore } from '../../stores/sessionStore'
import { rError, rInfo, rWarn } from '../../rendererLogger'

interface ConflictRow {
  path: string
  shape: string
  hasBase: boolean
  hasOurs: boolean
  hasTheirs: boolean
}

interface OpState {
  state: 'rebasing' | 'merging' | 'cherry-picking' | null
  branch: string | null
  onto: string | null
  oursLabel: string
  theirsLabel: string
  files: ConflictRow[]
}

export function ConflictsDialog({
  directory,
  onClose,
}: {
  directory: string
  onClose: () => void
}): React.JSX.Element {
  const colors = useColors()
  const [op, setOp] = useState<OpState | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyPath, setBusyPath] = useState<string | null>(null)
  const [mergePath, setMergePath] = useState<string | null>(null)
  const [confirmAbort, setConfirmAbort] = useState(false)
  const [footerBusy, setFooterBusy] = useState<'abort' | 'continue' | null>(null)

  // Shared GIT_OP_STATE → OpState mapping. Used both by `refresh()` (clears
  // any prior error on success) and by the post-continue/abort-failure probe
  // in `runFooter` (which must NOT clear the error — the operation's own
  // failure message is the useful thing on screen, and the freshly re-probed
  // `op` is what stops it from being contradicted by a stale empty file list).
  const applyOpStateResult = useCallback((result: Awaited<ReturnType<typeof window.ion.gitOpState>>): boolean => {
    if (result.ok) {
      setOp({
        state: result.state ?? null,
        branch: result.branch ?? null,
        onto: result.onto ?? null,
        oursLabel: result.oursLabel ?? 'yours',
        theirsLabel: result.theirsLabel ?? 'incoming',
        files: result.files ?? [],
      })
      return true
    }
    return false
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.ion.gitOpState(directory)
      if (applyOpStateResult(result)) {
        setError(null)
      } else {
        setError(result.error ?? 'Could not read the repository state.')
      }
    } finally {
      setLoading(false)
    }
  }, [directory, applyOpStateResult])

  useEffect(() => {
    void refresh().catch((err) => rError('git.conflicts', 'op state load failed', { error: String(err) }))
  }, [refresh])

  const accept = useCallback(async (path: string, side: 'ours' | 'theirs') => {
    setBusyPath(path)
    try {
      const result = await window.ion.gitConflictAccept(directory, path, side)
      if (!result.ok) {
        rWarn('git.conflicts', 'accept failed', { path, side, error: result.error ?? '' })
        setError(result.error ?? 'Accept failed.')
        return
      }
      rInfo('git.conflicts', 'accepted side for file', { path, side })
      await refresh()
    } finally {
      setBusyPath(null)
    }
  }, [directory, refresh])

  const runFooter = useCallback(async (verb: 'abort' | 'continue') => {
    setFooterBusy(verb)
    try {
      const result = verb === 'abort'
        ? await window.ion.gitRebaseAbort(directory)
        : await window.ion.gitRebaseContinue(directory)
      if (!result.ok) {
        rWarn('git.conflicts', 'operation verb failed', { verb, error: result.error ?? '' })
        setError(result.error ?? `${verb} failed.`)
        // A failed continue can still have walked the rebase forward onto a
        // BRAND NEW conflict further down the todo (git commits the resolved
        // step, then keeps applying — see the module header). The stale `op`
        // from before this call would otherwise keep showing an empty file
        // list and "All conflicts are resolved" directly under this failure
        // message. Re-probe and replace `op`, but deliberately do not touch
        // `error` here — the operation's own failure text is what belongs on
        // screen, not "state read OK".
        try {
          const opResult = await window.ion.gitOpState(directory)
          if (!applyOpStateResult(opResult)) {
            rWarn('git.conflicts', 'post-failure op state read failed', {
              verb, error: opResult.error ?? '',
            })
          }
        } catch (err) {
          rWarn('git.conflicts', 'post-failure op state read threw', { verb, error: String(err) })
        }
        return
      }
      rInfo('git.conflicts', 'operation verb succeeded', { verb, directory })
      // The operation ledger owns completion state. This keeps every shared
      // worktree control in sync after an Abort or Continue, including Studio.
      const ledger = useSessionStore.getState() as unknown as {
        completeConflictOperation?: (path: string, completedVerb: 'abort' | 'continue') => void
      }
      ledger.completeConflictOperation?.(directory, verb)
      // The operation is over either way — the alert clears on the next
      // inventory refresh; close so the operator sees the panel state.
      useSessionStore.getState().clearConflictAlert(directory)
      onClose()
    } finally {
      setFooterBusy(null)
    }
  }, [directory, onClose, applyOpStateResult])

  const title = op?.state === 'rebasing' && op.branch
    ? `Conflicts — rebasing ${op.branch}${op.onto ? ` onto ${op.onto}` : ''}`
    : op?.state === 'merging' ? 'Conflicts — merge in progress'
      : op?.state === 'cherry-picking' ? 'Conflicts — cherry-pick in progress'
        : 'Conflicts'

  const allResolved = (op?.files.length ?? 0) === 0 && op?.state != null

  return (
    <FloatingPanel title={title} onClose={onClose} defaultWidth={620} defaultHeight={420} workingDir={directory}>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        {error && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '6px 10px', fontSize: 11, color: colors.dangerFg }}>
            <Warning size={12} /> {error}
          </div>
        )}

        {/* Side legend: which branch each Accept button means. */}
        {op && (
          <div style={{ display: 'flex', gap: 14, padding: '6px 10px', fontSize: 10, color: colors.textSecondary }}>
            <span>Yours = <strong>{op.oursLabel}</strong></span>
            <span>Theirs = <strong>{op.theirsLabel}</strong></span>
          </div>
        )}

        <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
          {loading && (
            <div data-testid="conflict-state-loading" style={{ padding: '18px 12px', fontSize: 12, color: colors.textSecondary }}>
              Loading conflict state…
            </div>
          )}
          {!loading && op && op.files.length === 0 && (
            <div style={{ padding: '18px 12px', fontSize: 12, color: colors.textSecondary }}>
              {op.state
                ? 'All conflicts are resolved. Continue completes the operation.'
                : 'No conflicted files in this directory.'}
            </div>
          )}
          {!loading && op?.files.map((f) => (
            <div
              key={f.path}
              data-testid={`conflict-row-${f.path}`}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '5px 10px', borderBottom: `1px solid ${colors.containerBorder}`,
              }}
            >
              <span style={{ flex: 1, fontSize: 11, color: colors.textPrimary, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {f.path}
              </span>
              <span style={{ fontSize: 9, color: colors.textTertiary, flexShrink: 0 }}>{f.shape}</span>
              <button
                data-testid={`conflict-accept-ours-${f.path}`}
                onClick={() => { void accept(f.path, 'ours') }}
                disabled={busyPath !== null}
                style={{
                  fontSize: 10, padding: '2px 8px', borderRadius: 3, cursor: 'pointer',
                  border: `1px solid ${colors.containerBorder}`, background: 'transparent', color: colors.textPrimary,
                }}
              >
                Accept yours
              </button>
              <button
                data-testid={`conflict-accept-theirs-${f.path}`}
                onClick={() => { void accept(f.path, 'theirs') }}
                disabled={busyPath !== null}
                style={{
                  fontSize: 10, padding: '2px 8px', borderRadius: 3, cursor: 'pointer',
                  border: `1px solid ${colors.containerBorder}`, background: 'transparent', color: colors.textPrimary,
                }}
              >
                Accept theirs
              </button>
              <button
                data-testid={`conflict-merge-${f.path}`}
                onClick={() => setMergePath(f.path)}
                disabled={busyPath !== null}
                style={{
                  fontSize: 10, padding: '2px 8px', borderRadius: 3, cursor: 'pointer',
                  border: `1px solid ${colors.accent}`, background: colors.accentLight, color: colors.accent,
                }}
              >
                Merge…
              </button>
            </div>
          ))}
        </div>

        {/* Footer: the operation-level verbs. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderTop: `1px solid ${colors.containerBorder}` }}>
          <button
            data-testid="conflict-ai-assist"
            onClick={() => {
              // One forwarded store action (Studio rule): a fresh conversation in
              // the directory with the fixed prompt, on the standard tier, in
              // auto mode. The dialog stays open until the action succeeds so
              // a refusal (no standard tier configured) lands in the error
              // banner instead of vanishing with the dialog.
              void useSessionStore.getState().openConflictAssist(directory)
                .then(() => onClose())
                .catch((err) => {
                  rError('git.conflicts', 'assist failed', { error: String(err) })
                  setError(err instanceof Error ? err.message : String(err))
                })
            }}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              fontSize: 11, padding: '3px 10px', borderRadius: 4, cursor: 'pointer',
              border: `1px solid ${colors.accent}`, background: colors.accentLight, color: colors.accent,
            }}
          >
            <Robot size={12} /> AI Assisted
          </button>

          <span style={{ flex: 1 }} />

          <button
            data-testid="conflict-abort"
            onClick={() => setConfirmAbort(true)}
            disabled={footerBusy !== null || !op?.state}
            style={{
              fontSize: 11, padding: '3px 10px', borderRadius: 4, cursor: 'pointer',
              border: `1px solid ${colors.dangerFg}`, background: 'transparent', color: colors.dangerFg,
            }}
          >
            Abort
          </button>
          <button
            data-testid="conflict-continue"
            onClick={() => { void runFooter('continue') }}
            disabled={!allResolved || footerBusy !== null}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              fontSize: 11, padding: '3px 10px', borderRadius: 4,
              cursor: allResolved ? 'pointer' : 'default',
              border: `1px solid ${allResolved ? colors.worktreeGreen : colors.containerBorder}`,
              background: 'transparent',
              color: allResolved ? colors.worktreeGreen : colors.textTertiary,
            }}
          >
            {footerBusy === 'continue' ? <ArrowsClockwise size={12} className="animate-spin" /> : null}
            Continue
          </button>
          <button
            data-testid="conflict-close"
            onClick={onClose}
            style={{
              display: 'inline-flex', alignItems: 'center',
              fontSize: 11, padding: '3px 8px', borderRadius: 4, cursor: 'pointer',
              border: `1px solid ${colors.containerBorder}`, background: 'transparent', color: colors.textSecondary,
            }}
          >
            <X size={11} />
          </button>
        </div>
      </div>

      {mergePath && (
        <MergeEditor
          directory={directory}
          path={mergePath}
          onClose={() => setMergePath(null)}
          onResolved={() => {
            setMergePath(null)
            void refresh().catch((err) => rError('git.conflicts', 'refresh after merge failed', { error: String(err) }))
          }}
        />
      )}

      {confirmAbort && (
        <ConfirmDialog
          title="Abort the operation?"
          message="This returns the checkout to where it was before the operation started. Conflict resolutions made so far are discarded."
          confirmLabel="Abort"
          danger
          onConfirm={() => { setConfirmAbort(false); void runFooter('abort') }}
          onCancel={() => setConfirmAbort(false)}
        />
      )}
    </FloatingPanel>
  )
}

/**
 * buildWorktreeRowActions — the verb handlers behind WorktreeRowMenu.
 *
 * Split out of WorktreeRowMenu.tsx purely to keep both files under the
 * 600-line cap; the seam is the natural one (what the menu DOES vs. what the
 * menu LOOKS LIKE). The component keeps its own state, derived flags, and
 * rendering; this factory owns the six async verbs and the bench reorder, which
 * are the part with no JSX in them.
 *
 * It is a plain factory, not a hook: it calls no React primitive, so it is
 * safe to invoke after the component's early return.
 *
 * Every handler keeps the dismissal and busy-guard contract it had inline —
 * see the `items` doc comment in WorktreeRowMenu.tsx for why dismissal is
 * uniform and declared by the item table rather than by each handler.
 */
import { useSessionStore } from '../stores/sessionStore'
import { landFlagsForStrategy } from '../../shared/worktree-land-strategy'
import { resolveRetireBlockers } from '../stores/slices/worktree-occupant-close'
import { rDebug, rError, rInfo, rWarn } from '../rendererLogger'
import type { WorktreeInventoryEntry, WorktreeCompletionStrategy } from '../../shared/types'
import type { findMembership } from '../../shared/worktree-list'

/** Everything the verbs need from the menu component. */
export interface WorktreeRowActionsDeps {
  entry: WorktreeInventoryEntry
  repoPath: string
  strategy: WorktreeCompletionStrategy
  enrolled: ReturnType<typeof findMembership>
  draftTitle: string
  onClose(): void
  onRefresh(): void
  setBusy(v: boolean): void
  setRenaming(v: boolean): void
  setLandError(v: string | null): void
  setConfirmRetire(v: string | null): void
  setRetireOutcome(v: string | null): void
}

export interface WorktreeRowActions {
  doLand(): Promise<void>
  requestRetire(): Promise<void>
  doRetire(): Promise<void>
  doAddToBench(): Promise<void>
  doRename(): Promise<void>
  moveInBench(toIndex: number): void
}

export function buildWorktreeRowActions(deps: WorktreeRowActionsDeps): WorktreeRowActions {
  const {
    entry, repoPath, strategy, enrolled, draftTitle,
    onClose, onRefresh,
    setBusy, setRenaming, setLandError, setConfirmRetire, setRetireOutcome,
  } = deps

  async function doLand(): Promise<void> {
    if (!entry.sourceBranch) return
    setBusy(true)
    try {
      // Honour the operator's configured strategy. This used to pass no flags
      // at all, so a "Merge (ff)" setting silently produced a merge commit
      // whenever the source branch had moved on.
      const flags = landFlagsForStrategy(strategy)
      const result = await window.ion.gitWorktreeLand({
        repoPath,
        worktreePath: entry.worktreePath,
        worktreeBranch: entry.branchName,
        sourceBranch: entry.sourceBranch,
        noFf: flags.noFf,
        syncFirst: flags.syncFirst,
        requireFastForward: flags.requireFastForward,
      })
      if (!result.ok) {
        rWarn('worktree.menu', 'land refused', {
          branch: entry.branchName,
          has_conflicts: !!result.hasConflicts,
          error: result.error ?? '',
        })
        // A CONFLICT is not the same as a refusal. A refusal (diverged branch,
        // dirty tree) is answered by this dialog and nothing is left behind; a
        // conflict stops the merge halfway and leaves a checkout that needs
        // resolving, which must reach the toast and the row badge exactly as a
        // conflicted sync does. Without this the land path repeated the defect
        // the sync path was fixed for: an actionable failure visible only in
        // the log.
        //
        // Keyed on the directory the LAND reported, not on this worktree: the
        // merge runs in whichever checkout holds the source branch (usually the
        // base repo), and only a pre-sync conflict lands in the worktree.
        // Pointing the resolution dialog at the wrong directory would open it
        // on a clean tree.
        if (result.hasConflicts && result.conflictDirectory) {
          useSessionStore.getState().recordConflictAlert(result.conflictDirectory, {
            source: 'land',
            kind: 'conflict',
            message: result.error,
            label: result.conflictDirectory === entry.worktreePath
              ? (entry.title || entry.label)
              : result.conflictDirectory.split('/').filter(Boolean).pop(),
          })
        }
        // A refusal is actionable (sync first, resolve a conflict) and must not
        // vanish: surface it rather than leaving the operator to wonder why the
        // branch did not move.
        setLandError(result.error ?? 'Land failed.')
        return
      }
      rInfo('worktree.menu', 'landed', { branch: entry.branchName, mode: result.mode ?? '' })
      onRefresh()
      // Success dismisses the menu. The refusal path above returns early and
      // leaves it mounted on purpose, because the error dialog it raised is a
      // child of this component and would go with it.
      onClose()
    } finally {
      setBusy(false)
    }
  }

  /**
   * Retire asks two questions before it raises anything: is this worktree still
   * WORKING, and what would be lost.
   *
   * ── The active-work check comes first, and it is not a confirmation ─────────
   * A retire deletes the directory, so every conversation living there is closed
   * by it — and a conversation that is running, has dispatched background
   * agents, or has outstanding background commands cannot be closed (see
   * session-busy-guard.ts, which has no `force` on purpose). That is not something
   * to confirm past: the operator is told which conversations are active and
   * decides for themselves whether to interrupt or wait. So this arm raises the
   * acknowledge-only outcome dialog and never offers the Retire button at all.
   *
   * The store action re-checks the same thing — it is the enforcement point for
   * every path, including the ATV round trip. This check exists so the operator
   * is not shown a confirm button that is going to refuse (desktop/AGENTS.md
   * § "View readiness principle").
   *
   * ── The appraisal decides what the confirmation SAYS ───────────────────────
   * It never decides whether to confirm. This used to run the retire immediately
   * when `safeToDiscard` was true, so a landed worktree was deleted on a single
   * menu click with no prompt and no menu dismissal — the operator saw a context
   * menu still sitting open, then the row vanished two seconds later. Removing a
   * checkout is destructive whether or not the work is recoverable, and "nothing
   * would be lost" is the appraisal's opinion about git state, not the
   * operator's confirmation that they meant to click it.
   */
  async function requestRetire(): Promise<void> {
    // Predicted blast radius: the worktree plus any bench this retire would
    // empty. Bench directories host conversations too, and a retire that prunes
    // one deletes their working directory.
    let benchPaths: string[] = []
    try {
      const preview = await window.ion.gitWorktreeRetirePreview(entry.worktreePath)
      benchPaths = preview.prunedBenchPaths ?? []
    } catch (err) {
      rWarn('worktree.menu', 'retire preview failed; checking the worktree only', {
        worktree_path: entry.worktreePath, error: String(err),
      })
    }

    const blockers = resolveRetireBlockers(useSessionStore.getState, entry.worktreePath, benchPaths)
    if (blockers) {
      rInfo('worktree.menu', 'retire not offered: active work in the worktree', {
        branch: entry.branchName, active_count: blockers.active.length,
      })
      setRetireOutcome(blockers.error)
      return
    }

    if (!entry.sourceBranch) {
      setConfirmRetire('Ion cannot tell what this worktree still holds, because its source branch is unknown.')
      return
    }
    const appraisal = await window.ion.gitWorktreeAppraise(entry.worktreePath, entry.sourceBranch)
    rInfo('worktree.menu', 'retire appraised', {
      branch: entry.branchName,
      safe_to_discard: appraisal.safeToDiscard,
      uncommitted: appraisal.uncommittedPaths.length,
      unlanded: appraisal.unlandedCommitCount,
    })
    // Both arms confirm. Only the wording differs: a fully-landed worktree is
    // reported as costing nothing, which is information the operator wants
    // BEFORE deciding, not a reason to skip asking.
    setConfirmRetire(appraisal.safeToDiscard
      ? 'Everything in this worktree has landed, so nothing would be lost.'
      : appraisal.reason ?? 'This worktree may still hold work.')
  }

  async function doRetire(): Promise<void> {
    setBusy(true)
    try {
      // Routed through the store action rather than calling the IPC directly:
      // retire deletes the directory, so any conversation living in it must be
      // relocated first, and that read-then-mutate sequence must run in the
      // owner window. See retireWorktree in worktree-inventory-slice.ts.
      const result = await useSessionStore.getState().retireWorktree(
        repoPath,
        entry.worktreePath,
        entry.branchName,
      )
      // In the ATV window this is a FORWARDED action: the owner executes it and
      // its return value rides back over the round trip, so `result` is the
      // owner's real answer (see applyMirrorOverrides). It is absent only when
      // the round trip itself failed — no owner window, or no reply before
      // main's deadline — which is "no answer available", not "it failed", so
      // that case is logged rather than read as a refusal.
      if (!result) {
        rDebug('worktree.menu', 'retire returned no result (owner round trip did not complete)', {
          branch: entry.branchName,
        })
      } else if (!result.ok) {
        rWarn('worktree.menu', 'retire failed', { branch: entry.branchName, error: result.error ?? '' })
        // A refusal is actionable — most often "the recovery snapshot could not
        // be written, so the worktree was kept". Leaving it in the log while the
        // menu closes is what made the original defect look like a dead button.
        setRetireOutcome(result.error ?? 'Retire failed.')
        onRefresh()
        return
      }
      // Name the recovery ref. The confirmation promised the work was preserved;
      // a ref the operator never sees is indistinguishable from one that was
      // never written.
      if (result.recoveryRef) {
        rInfo('worktree.menu', 'retired with recovery ref', {
          branch: entry.branchName, recovery_ref: result.recoveryRef,
        })
        setRetireOutcome(
          `Retired. Uncommitted work was preserved to ${result.recoveryRef} in the repo. ` +
          `Recover it with: git checkout -b recovered ${result.recoveryRef}`,
        )
        onRefresh()
        return
      }
      rInfo('worktree.menu', 'retired', { branch: entry.branchName })
      onRefresh()
      setConfirmRetire(null)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  /**
   * Enroll this worktree in its bench, creating the bench if it does not exist.
   *
   * The bench is created silently on FIRST ENROLLMENT rather than as its own
   * user-facing step: `ensureWorkspace` writes a record, not a worktree (the
   * directory is materialised lazily by the first assembly), so "create a bench"
   * commits the operator to nothing and would be a meaningless extra click.
   * Which bench a worktree belongs to is fully determined by its repo and
   * source branch, so there is nothing to choose either.
   */
  async function doAddToBench(): Promise<void> {
    if (!entry.sourceBranch) return
    // No setBusy / onClose here: this item is not `keepsMenuOpen`, so the click
    // handler has already withdrawn the menu and this component is unmounting.
    // Setting state afterwards would be a no-op, and calling onClose again would
    // be a second dismissal of an already-dismissed menu.
    const result = await useSessionStore.getState()
      .benchAddMember(repoPath, entry.sourceBranch, entry.worktreePath, entry.branchName)
    // Same round-trip caveat as doRetire: absent only when the forwarded call
    // never concluded, never merely because the mirror ran it.
    if (!result) {
      rDebug('worktree.menu', 'add to bench returned no result (owner round trip did not complete)', {
        branch: entry.branchName,
      })
    } else if (!result.ok) {
      rWarn('worktree.menu', 'add to bench refused', { branch: entry.branchName, error: result.error ?? '' })
    } else {
      rInfo('worktree.menu', 'added to bench', { branch: entry.branchName, source_branch: entry.sourceBranch })
    }
    onRefresh()
  }

  /**
   * Apply an operator-supplied title. Empty input is a cancel, not a clear:
   * blanking the name would drop the row back to its hex slug, which is never
   * what someone typing into a rename field is asking for.
   */
  async function doRename(): Promise<void> {
    const next = draftTitle.trim()
    if (!next || next === (entry.title ?? '')) {
      setRenaming(false)
      onClose()
      return
    }
    setBusy(true)
    try {
      const result = await window.ion.gitWorktreeSetTitle({
        worktreePath: entry.worktreePath,
        repoPath,
        title: next,
      })
      if (!result.ok) {
        rWarn('worktree.menu', 'rename refused', {
          worktree_path: entry.worktreePath, error: result.error ?? '',
        })
      } else {
        rInfo('worktree.menu', 'worktree renamed', { worktree_path: entry.worktreePath, title: next })
      }
      onRefresh()
    } finally {
      setBusy(false)
      setRenaming(false)
      onClose()
    }
  }

  function moveInBench(toIndex: number): void {
    if (!enrolled) return
    void useSessionStore.getState()
      .benchSetOrder(repoPath, enrolled.sourceBranch, entry.worktreePath, toIndex)
      .catch((err) => rError('worktree.menu', 'reorder failed', { error: String(err) }))
    onClose()
  }

  return { doLand, requestRetire, doRetire, doAddToBench, doRename, moveInBench }
}

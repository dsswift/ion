/**
 * useWorktreeRowMenuVerbs — the side-effecting verbs behind WorktreeRowMenu.
 *
 * Extracted from WorktreeRowMenu.tsx to keep that file under the 600-line cap.
 * The seam is behavioural rather than cosmetic: everything here PERFORMS an
 * operation against a worktree (land, retire, enrol in a bench, rename, reorder)
 * and owns the dialog and busy state those operations surface. What stays in the
 * component is the menu's assembly and rendering.
 *
 * The verbs are returned rather than invoked so the component keeps deciding
 * WHEN each runs — see the dismissal contract documented on `items` there. This
 * hook only decides what each verb DOES.
 */
import { useState } from "react";
import { useSessionStore } from "../stores/sessionStore";
import { usePreferencesStore } from "../preferences";
import { landFlagsForStrategy } from "../../shared/worktree-land-strategy";
import { findMembership } from "../../shared/worktree-list";
import { resolveRetireBlockers } from "../stores/slices/worktree-occupant-close";
import { rDebug, rError, rInfo, rWarn } from "../rendererLogger";
import type { WorktreeInventoryEntry } from "../../shared/types";

export function useWorktreeRowMenuVerbs({
  entry,
  repoPath,
  onClose,
  onRefresh,
}: {
  entry: WorktreeInventoryEntry;
  repoPath: string;
  onClose(): void;
  onRefresh(): void;
}) {
  const benchWorkspaces = useSessionStore((s) =>
    s.benchWorkspaces.get(repoPath),
  );
  const strategy = usePreferencesStore((s) => s.worktreeCompletionStrategy);
  const [busy, setBusy] = useState(false);
  const [confirmRetire, setConfirmRetire] = useState<string | null>(null);
  const [confirmDiscardRecordings, setConfirmDiscardRecordings] = useState<
    string | null
  >(null);
  const [discardRecordingsOutcome, setDiscardRecordingsOutcome] = useState<
    string | null
  >(null);
  // A land refusal (diverged branch, conflict) is actionable and must be shown,
  // not swallowed into the log while the menu closes as if it had worked.
  const [landError, setLandError] = useState<string | null>(null);
  // The retire outcome the operator must read: either the recovery ref that now
  // holds their uncommitted work, or the reason the worktree was kept.
  const [retireOutcome, setRetireOutcome] = useState<string | null>(null);
  // Inline rename state. The generated title is a good default, not an
  // authority — the operator must be able to correct one that missed.
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState(entry.title ?? entry.label);
  // Bench membership. Derived here and returned so the component reads the same
  // value the verbs act on rather than deriving it a second time.
  const enrolled = findMembership(benchWorkspaces ?? [], entry.worktreePath);

  async function doLand(): Promise<void> {
    if (!entry.sourceBranch) return;
    setBusy(true);
    try {
      // Honour the operator's configured strategy. This used to pass no flags
      // at all, so a "Merge (ff)" setting silently produced a merge commit
      // whenever the source branch had moved on.
      const flags = landFlagsForStrategy(strategy);
      const result = await window.ion.gitWorktreeLand({
        repoPath,
        worktreePath: entry.worktreePath,
        worktreeBranch: entry.branchName,
        sourceBranch: entry.sourceBranch,
        noFf: flags.noFf,
        syncFirst: flags.syncFirst,
        requireFastForward: flags.requireFastForward,
      });
      if (!result.ok) {
        rWarn("worktree.menu", "land refused", {
          branch: entry.branchName,
          has_conflicts: !!result.hasConflicts,
          error: result.error ?? "",
        });
        // A conflict is not a refusal. A refusal (diverged branch or dirty
        // tree) is answered by this dialog and leaves nothing behind. A conflict
        // stops merge halfway, leaving a checkout that needs resolution. Record
        // it for Git panel banner while inventory refresh updates row controls.
        //
        // Keyed on the directory the LAND reported, not on this worktree: the
        // merge runs in whichever checkout holds the source branch (usually the
        // base repo), and only a pre-sync conflict lands in the worktree.
        // Pointing the resolution dialog at the wrong directory would open it
        // on a clean tree.
        if (result.hasConflicts && result.conflictDirectory) {
          useSessionStore
            .getState()
            .recordConflictAlert(result.conflictDirectory, {
              operationState: result.conflictDirectory === entry.worktreePath
                ? 'rebasing'
                : 'merging',
              label:
                result.conflictDirectory === entry.worktreePath
                  ? entry.title || entry.label
                  : result.conflictDirectory.split("/").filter(Boolean).pop(),
            });
        }
        // A refusal is actionable (sync first, resolve a conflict) and must not
        // vanish: surface it rather than leaving the operator to wonder why the
        // branch did not move.
        setLandError(result.error ?? "Land failed.");
        return;
      }
      rInfo("worktree.menu", "landed", {
        branch: entry.branchName,
        mode: result.mode ?? "",
        pruned_benches: result.prunedBenchPaths?.length ?? 0,
      });
      await useSessionStore.getState().sealLandedWorktree(entry.worktreePath);
      onRefresh();
      // Success dismisses the menu. The refusal path above returns early and
      // leaves it mounted on purpose, because the error dialog it raised is a
      // child of this component and would go with it.
      onClose();
    } finally {
      setBusy(false);
    }
  }

  /**
   * Retire first checks every conversation its deletion would close, including
   * conversations in a bench the retirement would prune. Active work is never
   * confirmable, so this path reports the blocker rather than offering a button
   * the store action must refuse.
   *
   * The appraisal then decides confirmation wording. It never decides whether
   * confirmation is required: removing a checkout is destructive even when all
   * work has landed.
   */
  async function requestRetire(): Promise<void> {
    let benchPaths: string[] = [];
    try {
      const preview = await window.ion.gitWorktreeRetirePreview(
        entry.worktreePath,
      );
      benchPaths = preview.prunedBenchPaths ?? [];
    } catch (err) {
      rWarn(
        "worktree.menu",
        "retire preview failed; checking the worktree only",
        {
          worktree_path: entry.worktreePath,
          error: String(err),
        },
      );
    }

    const blockers = resolveRetireBlockers(
      useSessionStore.getState,
      entry.worktreePath,
      benchPaths,
    );
    if (blockers) {
      rInfo(
        "worktree.menu",
        "retire not offered: active work in the worktree",
        {
          branch: entry.branchName,
          active_count: blockers.active.length,
        },
      );
      setRetireOutcome(blockers.error);
      return;
    }

    if (!entry.sourceBranch) {
      setConfirmRetire(
        "Ion cannot tell what this worktree still holds, because its source branch is unknown.",
      );
      return;
    }
    const appraisal = await window.ion.gitWorktreeAppraise(
      entry.worktreePath,
      entry.sourceBranch,
    );
    rInfo("worktree.menu", "retire appraised", {
      branch: entry.branchName,
      safe_to_discard: appraisal.safeToDiscard,
      uncommitted: appraisal.uncommittedPaths.length,
      unlanded: appraisal.unlandedCommitCount,
    });
    setConfirmRetire(
      appraisal.safeToDiscard
        ? "Everything in this worktree has landed, so nothing would be lost."
        : (appraisal.reason ?? "This worktree may still hold work."),
    );
  }

  async function doRetire(): Promise<void> {
    setBusy(true);
    try {
      // Routed through the store action rather than calling the IPC directly:
      // retire deletes the directory, so any conversation living in it must be
      // relocated first, and that read-then-mutate sequence must run in the
      // owner window. See retireWorktree in worktree-inventory-slice.ts.
      const result = await useSessionStore
        .getState()
        .retireWorktree(repoPath, entry.worktreePath, entry.branchName);
      // In the ATV window this is a FORWARDED action: the owner executes it and
      // its return value rides back over the round trip, so `result` is the
      // owner's real answer (see applyMirrorOverrides). It is absent only when
      // the round trip itself failed — no owner window, or no reply before
      // main's deadline — which is "no answer available", not "it failed", so
      // that case is logged rather than read as a refusal.
      if (!result) {
        rDebug(
          "worktree.menu",
          "retire returned no result (owner round trip did not complete)",
          {
            branch: entry.branchName,
          },
        );
      } else if (!result.ok) {
        rWarn("worktree.menu", "retire failed", {
          branch: entry.branchName,
          error: result.error ?? "",
        });
        // A refusal is actionable — most often "the recovery snapshot could not
        // be written, so the worktree was kept". Leaving it in the log while the
        // menu closes is what made the original defect look like a dead button.
        setRetireOutcome(result.error ?? "Retire failed.");
        onRefresh();
        return;
      }
      // Name the recovery ref. The confirmation promised the work was preserved;
      // a ref the operator never sees is indistinguishable from one that was
      // never written.
      if (result.recoveryRef) {
        rInfo("worktree.menu", "retired with recovery ref", {
          branch: entry.branchName,
          recovery_ref: result.recoveryRef,
        });
        setRetireOutcome(
          `Retired. Uncommitted work was preserved to ${result.recoveryRef} in the repo. ` +
            `Recover it with: git checkout -b recovered ${result.recoveryRef}`,
        );
        onRefresh();
        return;
      }
      rInfo("worktree.menu", "retired", { branch: entry.branchName });
      onRefresh();
      setConfirmRetire(null);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  async function doDiscardRecordings(): Promise<void> {
    if (!enrolled) return;
    setBusy(true);
    try {
      const result = await useSessionStore
        .getState()
        .benchDiscardMemberRecordings(repoPath, enrolled.sourceBranch, [
          enrolled.membership.branchName,
        ]);
      const forgotten = result.forgottenCount ?? 0;
      const noMatch =
        result.branchesWithNothingToForget?.includes(
          enrolled.membership.branchName,
        ) ?? false;
      if (!result.ok) {
        rWarn("worktree.menu", "discard member recordings failed", {
          branch: enrolled.membership.branchName,
          error: result.error ?? "",
        });
        setDiscardRecordingsOutcome(
          result.error ??
            "Could not discard this worktree’s recorded resolutions.",
        );
        return;
      }
      if (noMatch || forgotten === 0) {
        rInfo("worktree.menu", "no matching member recording to discard", {
          branch: enrolled.membership.branchName,
          outcome: result.workspace?.lastAssembly ?? "unknown",
        });
        setDiscardRecordingsOutcome(
          `No recorded resolution matched ${enrolled.membership.branchName}. The bench reassembled without deleting any other recording.`,
        );
        return;
      }
      const needsResolution =
        result.workspace?.lastAssembly === "failed" &&
        result.workspace.lastAssemblyFailure === "conflict";
      rInfo("worktree.menu", "discarded member recordings", {
        branch: enrolled.membership.branchName,
        forgotten_count: forgotten,
        outcome: result.workspace?.lastAssembly ?? "unknown",
        fresh_conflict: needsResolution,
      });
      setDiscardRecordingsOutcome(
        needsResolution
          ? `Discarded ${forgotten} recorded resolution${forgotten === 1 ? "" : "s"} for ${enrolled.membership.branchName}. The bench now has a fresh conflict to resolve; all other recordings remain.`
          : `Discarded ${forgotten} recorded resolution${forgotten === 1 ? "" : "s"} for ${enrolled.membership.branchName}. The bench reassembled; all other recordings remain.`,
      );
    } catch (err) {
      rError("worktree.menu", "discard member recordings threw", {
        branch: enrolled.membership.branchName,
        error: String(err),
      });
      setDiscardRecordingsOutcome(
        `Could not discard this worktree’s recorded resolutions: ${String(err)}`,
      );
    } finally {
      setBusy(false);
      onRefresh();
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
    if (!entry.sourceBranch) return;
    // No setBusy / onClose here: this item is not `keepsMenuOpen`, so the click
    // handler has already withdrawn the menu and this component is unmounting.
    // Setting state afterwards would be a no-op, and calling onClose again would
    // be a second dismissal of an already-dismissed menu.
    const result = await useSessionStore
      .getState()
      .benchAddMember(
        repoPath,
        entry.sourceBranch,
        entry.worktreePath,
        entry.branchName,
      );
    // Same round-trip caveat as doRetire: absent only when the forwarded call
    // never concluded, never merely because the mirror ran it.
    if (!result) {
      rDebug(
        "worktree.menu",
        "add to bench returned no result (owner round trip did not complete)",
        {
          branch: entry.branchName,
        },
      );
    } else if (!result.ok) {
      rWarn("worktree.menu", "add to bench refused", {
        branch: entry.branchName,
        error: result.error ?? "",
      });
    } else {
      rInfo("worktree.menu", "added to bench", {
        branch: entry.branchName,
        source_branch: entry.sourceBranch,
      });
    }
    onRefresh();
  }

  /**
   * Apply an operator-supplied title. Empty input is a cancel, not a clear:
   * blanking the name would drop the row back to its hex slug, which is never
   * what someone typing into a rename field is asking for.
   */
  async function doRename(): Promise<void> {
    const next = draftTitle.trim();
    if (!next || next === (entry.title ?? "")) {
      setRenaming(false);
      onClose();
      return;
    }
    setBusy(true);
    try {
      const result = await window.ion.gitWorktreeSetTitle({
        worktreePath: entry.worktreePath,
        repoPath,
        title: next,
      });
      if (!result.ok) {
        rWarn("worktree.menu", "rename refused", {
          worktree_path: entry.worktreePath,
          error: result.error ?? "",
        });
      } else {
        rInfo("worktree.menu", "worktree renamed", {
          worktree_path: entry.worktreePath,
          title: next,
        });
      }
      onRefresh();
    } finally {
      setBusy(false);
      setRenaming(false);
      onClose();
    }
  }

  // Merge order IS array position, so the menu reads and writes an index rather
  // than a stored rank that could disagree with the array assembly walks.
  const benchMembers = enrolled
    ? ((benchWorkspaces ?? []).find(
        (w) => w.sourceBranch === enrolled.sourceBranch,
      )?.members ?? [])
    : [];
  const benchIndex = benchMembers.findIndex(
    (m) => m.worktreePath === entry.worktreePath,
  );
  const benchSize = benchMembers.length;

  function moveInBench(toIndex: number): void {
    if (!enrolled) return;
    void useSessionStore
      .getState()
      .benchSetOrder(
        repoPath,
        enrolled.sourceBranch,
        entry.worktreePath,
        toIndex,
      )
      .catch((err) =>
        rError("worktree.menu", "reorder failed", { error: String(err) }),
      );
    onClose();
  }

  return {
    doLand,
    requestRetire,
    doRetire,
    doAddToBench,
    doDiscardRecordings,
    doRename,
    moveInBench,
    enrolled,
    // The configured land strategy. Returned because the menu names the strategy
    // in the land item's hint, so the label and the flags doLand actually passes
    // are read from one value rather than two lookups that could disagree.
    strategy,
    benchIndex,
    benchSize,
    busy,
    confirmRetire,
    setConfirmRetire,
    confirmDiscardRecordings,
    setConfirmDiscardRecordings,
    discardRecordingsOutcome,
    setDiscardRecordingsOutcome,
    retireOutcome,
    setRetireOutcome,
    landError,
    setLandError,
    renaming,
    setRenaming,
    draftTitle,
    setDraftTitle,
  };
}

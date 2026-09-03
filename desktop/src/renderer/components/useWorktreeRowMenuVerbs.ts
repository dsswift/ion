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
import { findMembership } from "../../shared/worktree-list";
import { resolveRetireBlockers } from "../stores/slices/worktree-occupant-close";
import { rDebug, rError, rInfo, rWarn } from "../rendererLogger";
import type { WorktreeInventoryEntry } from "../../shared/types";

/**
 * The land-and-retire confirmation, captured when the operator opens it.
 *
 * `hasNothingToLand` is FROZEN here rather than re-derived from the live entry.
 * The land half of the operation drops `entry.unlandedCommitCount` to 0 while
 * the retire half is still running; deriving the dialog's title/label from the
 * live value flipped "Land and retire this worktree?" to "Retire this
 * worktree?" mid-flight, which read as a second confirmation appearing and
 * auto-accepting. Freezing both the message and the flag together keeps the
 * dialog's identity fixed for the whole operation.
 */
export interface RetireConfirm {
  message: string;
  hasNothingToLand: boolean;
}

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
  // The operation ledger is the source of truth for in-flight workspace
  // mutations in both presentations (see studio/README.md — no local busy
  // flags). Land/retire now record a `running` entry keyed by worktreePath;
  // a match here is what raises `busy` for the confirm dialog. The field is
  // `workspaceOperationLedger` — an earlier `worktreeOperations` read never
  // matched a real store key, so this dialog never went busy at all.
  const operation = useSessionStore((s) =>
    [...s.workspaceOperationLedger.values()].find(
      (item) => item.worktreePath === entry.worktreePath && item.status === 'running',
    ),
  );
  const busy = operation !== undefined;
  const [confirmRetire, setConfirmRetire] = useState<RetireConfirm | null>(null);
  const [confirmDiscardWorktree, setConfirmDiscardWorktree] = useState<string | null>(null);
  const [confirmDiscardRecordings, setConfirmDiscardRecordings] = useState<
    string | null
  >(null);
  const [discardRecordingsOutcome, setDiscardRecordingsOutcome] = useState<
    string | null
  >(null);
  // A land refusal (diverged branch, conflict) is actionable and must be shown,
  // not swallowed into the log while the menu closes as if it had worked.
  const [landError, setLandError] = useState<string | null>(null);
  const [discardError, setDiscardError] = useState<string | null>(null);
  // Inline rename state. The generated title is a good default, not an
  // authority — the operator must be able to correct one that missed.
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState(entry.title ?? entry.label);
  // Bench membership. Derived here and returned so the component reads the same
  // value the verbs act on rather than deriving it a second time.
  const enrolled = findMembership(benchWorkspaces ?? [], entry.worktreePath);

  async function requestLandAndRetire(): Promise<void> {
    if (!entry.sourceBranch) {
      setLandError('Ion does not know what branch this worktree came from.')
      return
    }
    let benchPaths: string[] = []
    try {
      benchPaths = (await window.ion.gitWorktreeRetirePreview(entry.worktreePath)).prunedBenchPaths ?? []
    } catch (error) {
      rWarn('worktree.menu', 'terminal completion preview failed', {
        worktree_path: entry.worktreePath,
        error: String(error),
      })
    }
    const blockers = resolveRetireBlockers(useSessionStore.getState, entry.worktreePath, benchPaths)
    if (blockers) {
      setLandError(blockers.error)
      return
    }
    // A worktree with nothing to land (a mistakenly created one, or work
    // abandoned before the first commit) still needs a way to be discarded.
    // The confirmation says so honestly rather than promising a merge that
    // `landAndRetireWorktree` will skip. Both the wording and the flag are
    // captured now so the dialog cannot change identity mid-operation.
    const hasNothingToLand = entry.unlandedCommitCount === 0
    setConfirmRetire({
      hasNothingToLand,
      message: hasNothingToLand
        ? `This worktree has nothing to land. It will be discarded: nothing merges into ${entry.sourceBranch}, and the worktree, branch, and its finished conversations are removed.`
        : `This merges into ${entry.sourceBranch}, then removes the worktree, branch, and its finished conversations.`,
    })
  }

  async function requestDiscardWorktree(): Promise<void> {
    if (!entry.sourceBranch) {
      setDiscardError('Ion does not know what branch this worktree came from.')
      return
    }
    let benchPaths: string[] = []
    try {
      benchPaths = (await window.ion.gitWorktreeRetirePreview(entry.worktreePath)).prunedBenchPaths ?? []
    } catch (error) {
      rWarn('worktree.menu', 'discard preview failed; checking the worktree only', {
        worktree_path: entry.worktreePath,
        error: String(error),
      })
    }
    const blockers = resolveRetireBlockers(useSessionStore.getState, entry.worktreePath, benchPaths)
    if (blockers) {
      setDiscardError(blockers.error)
      return
    }

    try {
      const appraisal = await window.ion.gitWorktreeAppraise(entry.worktreePath, entry.sourceBranch)
      if (appraisal.appraisalFailed) {
        setDiscardError(appraisal.reason ?? 'Could not determine what this worktree contains.')
        return
      }
      const risks: string[] = []
      if (appraisal.uncommittedPaths.length > 0) {
        risks.push(`${appraisal.uncommittedPaths.length} uncommitted file${appraisal.uncommittedPaths.length === 1 ? '' : 's'}`)
      }
      if (appraisal.unlandedCommitCount > 0) {
        risks.push(`${appraisal.unlandedCommitCount} commit${appraisal.unlandedCommitCount === 1 ? '' : 's'} not yet landed in ${entry.sourceBranch}`)
      }
      setConfirmDiscardWorktree(
        risks.length === 0
          ? `This removes the worktree, its branch, and finished conversations. Nothing merges into ${entry.sourceBranch}.`
          : `This removes the worktree, its branch, and finished conversations. Nothing merges into ${entry.sourceBranch}. Ion will first save ${risks.join(' and ')} to recovery refs.`,
      )
    } catch (error) {
      rWarn('worktree.menu', 'discard appraisal failed', {
        worktree_path: entry.worktreePath,
        error: String(error),
      })
      setDiscardError('Could not determine what this worktree contains. It was not removed.')
    }
  }

  async function doDiscardWorktree(): Promise<void> {
    if (!entry.sourceBranch) return
    const result = await useSessionStore.getState().retireWorktree(
      repoPath,
      entry.worktreePath,
      entry.branchName,
    )
    if (!result.ok) {
      setConfirmDiscardWorktree(null)
      setDiscardError(result.error ?? 'Discard worktree failed.')
      return
    }
    rInfo('worktree.menu', 'worktree discarded without landing', {
      worktree_path: entry.worktreePath,
      recovery_ref: result.recoveryRef ?? '',
      pruned_benches: result.prunedBenchPaths?.length ?? 0,
    })
    onRefresh()
    setConfirmDiscardWorktree(null)
    onClose()
  }
  async function doLandAndRetire(): Promise<void> {
    if (!entry.sourceBranch) return
    try {
      const result = await useSessionStore.getState().landAndRetireWorktree(repoPath, {
        worktreePath: entry.worktreePath,
        branchName: entry.branchName,
        sourceBranch: entry.sourceBranch,
        title: entry.title,
        label: entry.label,
      })
      if (!result.ok) {
        setLandError(result.error ?? 'Land and retire failed.')
        return
      }
      onRefresh()
      setConfirmRetire(null)
      onClose()
    } finally {
      onRefresh()
    }
  }

  async function doDiscardRecordings(): Promise<void> {
    if (!enrolled) return;
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

  async function doRemoveFromBench(): Promise<void> {
    if (!enrolled) return;
    await useSessionStore.getState().benchRemoveMember(
      repoPath,
      enrolled.sourceBranch,
      entry.worktreePath,
    );
    rInfo("worktree.menu", "removed from bench", {
      worktree_path: entry.worktreePath,
      source_branch: enrolled.sourceBranch,
    });
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
    requestLandAndRetire,
    doLandAndRetire,
    requestDiscardWorktree,
    doDiscardWorktree,
    doAddToBench,
    doRemoveFromBench,
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
    confirmDiscardWorktree,
    setConfirmDiscardWorktree,
    confirmDiscardRecordings,
    setConfirmDiscardRecordings,
    discardRecordingsOutcome,
    setDiscardRecordingsOutcome,
    landError,
    setLandError,
    discardError,
    setDiscardError,
    renaming,
    setRenaming,
    draftTitle,
    setDraftTitle,
  };
}

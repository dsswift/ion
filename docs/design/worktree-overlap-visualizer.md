# Worktree overlap visualizer

## Purpose

This desktop window shows exact Git evidence before selecting worktrees for an integration bench. It helps answer which parallel changes touch the same directories, files, or base-coordinate hunks, and whether Git predicts the selected committed contributions will merge.

## Recommendation

**Recommended fast lane** is an exact low-friction cohort, not a risk score. Within the exact-search candidate budget, Ion evaluates ordered subsets with the same in-memory merge sequence used by bench assembly. It chooses, in order:

1. largest cohort that merges cleanly;
2. least committed shared-file and same-hunk overlap among those equally large cohorts;
3. existing bench order, then stable worktree order.

Every excluded worktree names a concrete reason: a merge counterpart and its conflict paths, no committed contribution, a missing comparison base, or work already landed in the source branch. Large sets use an explicitly labelled anchored search rather than claiming a global optimum. Auto-order never factorial-searches more than the bounded candidate count; larger selections retain their current order after exact merge validation. Selecting a cohort changes only visualizer state until Apply confirms its exact membership and merge-order changes.


- **Live tips** compares each worktree's current committed branch contribution against its recorded worktree base. Staged, unstaged, and untracked paths appear as advisory overlap only. They cannot enter a bench until committed.
- **Current bench pins** compares only contributions currently pinned by the selected bench. This is what the current assembly can merge.
- **Matrix cells** show exact merge conflicts first, then same-hunk file overlap, then same-file overlap, then shared-directory-only overlap. No percentage risk score is generated.
- **Changed-path partition** sizes paths by changed-line volume. Binary and untracked paths use a minimum visible weight.
- **Incomplete coverage** means Ion has no recorded contribution base for a worktree. The window names it instead of guessing.

## Ownership

The visualizer lets the operator select an eligible clean cohort, review exact membership changes, then atomically persist bench enrollment, enabled state, and merge order. It never assembles a bench or advances an existing pin. Apply revalidates every selected path, rejects duplicates, and refuses persistence failures.

Conflict prediction uses `git merge-tree --write-tree --name-only -z`, which performs an in-memory merge without changing a checkout or index. Human Git conflict messages are not parsed because Git does not promise their stability.

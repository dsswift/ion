import Foundation

/// A close awaiting the operator's answer, because the tab's worktree still
/// holds work. Carries the resolved summary so the alert renders complete on
/// first presentation rather than resolving it again while visible.
struct PendingCloseWarning: Identifiable, Equatable {
    let tabId: String
    let summary: String

    var id: String { tabId }
}

/// What closing a worktree conversation leaves behind on iOS.
///
/// ── Why this exists ─────────────────────────────────────────────────────────
/// The desktop warns before closing a conversation that sits on uncommitted
/// files or unlanded commits: nothing is destroyed (a worktree outlives its
/// conversations, and removal is the explicit Retire verb), but "you are walking
/// away from 4 unlanded commits" is information the operator wants at that
/// moment. iOS closed tabs by swipe-delete with no confirmation at all, so the
/// same close was silent on the phone — a parity gap in a surface that already
/// had the facts.
///
/// ── Why no new wire member ──────────────────────────────────────────────────
/// `RemoteWorktree` already carries `isDirty` and `unlandedCommitCount` (the
/// Worktrees screen renders both), and a tab resolves to its worktree by
/// `workingDirectory` — the same match `TabRowContextMenu` uses. So the warning
/// is derived from state the phone already holds; no `desktop_` command, no
/// protocol change.
///
/// ── The one divergence from desktop, stated deliberately ────────────────────
/// The desktop runs a FRESH `gitWorktreeAppraise` at the moment of closing. iOS
/// reads the last snapshot, so its counts can lag by one refresh interval. That
/// is acceptable here and not worth a round-trip: the warning is informational
/// (the close is never destructive either way), and a slightly stale "3 commits
/// not yet landed" still tells the operator the thing that matters — that this
/// worktree holds work. It must never claim the opposite, so a worktree the
/// snapshot cannot account for warns rather than staying silent.
enum WorktreeCloseWarning {
    /// Build the operator-facing warning for closing `tab`, or nil when the
    /// close is uneventful.
    ///
    /// Returns nil for a plain conversation (no second lifetime to warn about)
    /// and for a worktree that is clean and fully landed. Mirrors
    /// `decideWorktreeClose` in `desktop/src/shared/worktree-close-decision.ts`,
    /// including its wording, so the two clients do not describe the same state
    /// two different ways.
    static func summary(for tab: RemoteTabState, worktreeStates: [String: RemoteWorktreeState]) -> String? {
        guard let worktree = resolve(tab: tab, in: worktreeStates) else { return nil }

        var parts: [String] = []
        if worktree.isDirty {
            // The snapshot carries a dirty FLAG, not a file count (iOS has no
            // surface that lists the paths), so the phrasing cannot name a
            // number the way the desktop does.
            parts.append("uncommitted changes")
        }
        if worktree.unlandedCommitCount > 0 {
            let n = worktree.unlandedCommitCount
            parts.append("\(n) commit\(n == 1 ? "" : "s") not yet landed")
        }

        // Mid-operation (a conflicted sync leaves a rebase in progress) the
        // appraisal fields are conservative defaults rather than live answers,
        // so this must not report "nothing to lose". Warn on the operation
        // itself, which is also the more urgent fact.
        if worktree.operationState != nil {
            return "This worktree is mid-\(operationName(worktree.operationState)) and still exists. Nothing is deleted — reopen it any time from Inbox."
        }

        guard !parts.isEmpty else { return nil }
        return "This worktree keeps \(parts.joined(separator: " and ")). Nothing is deleted — reopen it any time from Inbox."
    }

    /// Operation name for display. Matches `WorktreeRowView.conflictChipText`,
    /// including its default: an unrecognised state decodes to `.rebasing`, so
    /// "rebasing" is the generic "an operation is in progress" wording.
    private static func operationName(_ state: RemoteWorktree.OperationState?) -> String {
        switch state {
        case .merging: return "merge"
        case .cherryPicking: return "cherry-pick"
        default: return "rebase"
        }
    }

    /// The worktree a tab is running in, matched on working directory.
    ///
    /// Same resolution `TabRowContextMenu.worktreeForTab` performs: read the
    /// desktop's projection rather than inferring a worktree from the path
    /// shape, so a directory that merely looks like `~/.ion/worktrees/...` is
    /// never treated as a registered worktree.
    static func resolve(
        tab: RemoteTabState,
        in worktreeStates: [String: RemoteWorktreeState]
    ) -> RemoteWorktree? {
        for state in worktreeStates.values {
            if let match = state.worktrees.first(where: { $0.worktreePath == tab.workingDirectory }) {
                return match
            }
        }
        return nil
    }
}

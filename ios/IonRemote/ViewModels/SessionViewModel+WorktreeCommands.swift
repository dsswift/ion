import Foundation

// MARK: - Worktree + integration bench commands
//
// iOS's constraint shapes this: the git pane sits one layer BELOW a
// conversation, so reaching it costs two navigations from the tab list. The
// high-frequency actions (open a conversation in a worktree or the bench) are
// therefore surfaced at the shallowest depth -- the new-tab sheet and the
// tab-row menu -- while the low-frequency management verbs (land, retire)
// stay in the git pane next to the diff the operator consults first.

extension SessionViewModel {

    /// Worktree + bench state for a project, if it has been fetched.
    func worktreeState(for repoPath: String) -> RemoteWorktreeState? {
        worktreeStates[repoPath]
    }

    /// Every project with a fetched worktree state, sorted for stable display.
    var worktreeProjects: [RemoteWorktreeState] {
        worktreeStates.values.sorted { $0.repoPath < $1.repoPath }
    }

    /// The repo a tab's worktrees belong to. A worktree tab's siblings live
    /// under its PARENT repo, not under the worktree directory.
    func repoPath(forTab tabId: String) -> String? {
        guard let tab = tab(for: tabId) else { return nil }
        // The desktop projects the worktree's repo onto the tab when it knows
        // it; otherwise the working directory IS the repo.
        let dir = tab.workingDirectory
        guard !dir.isEmpty, dir != "~" else { return nil }
        return worktreeStates.values
            .first { $0.worktrees.contains { $0.worktreePath == dir } }?
            .repoPath ?? dir
    }

    /// True when `directory` is a worktree whose base branch has moved on.
    /// Used by the tab row so the operator sees they are building against stale
    /// code without drilling into the git pane.
    func isWorktreeBaseStale(_ directory: String) -> Bool {
        guard !directory.isEmpty else { return false }
        return worktreeStates.values.contains { state in
            state.worktrees.contains { $0.worktreePath == directory && $0.needsSync }
        }
    }

    /// Refresh worktree + bench state for a project.
    ///
    /// `.automaticEssential`: a screen-required background load with no
    /// re-triggering call site, so a send during a transport gap must defer
    /// rather than be dropped.
    func refreshWorktrees(repoPath: String) {
        guard !repoPath.isEmpty, repoPath != "~" else { return }
        send(.worktreeRefresh(repoPath: repoPath), intent: .automaticEssential)
    }

    /// Refresh every project that currently has a tab open, so the new-tab
    /// sheet lists worktrees the moment it appears rather than a beat later.
    func refreshAllWorktrees() {
        let repos = Set(tabs.map(\.workingDirectory).filter { !$0.isEmpty && $0 != "~" })
        for repo in repos {
            send(.worktreeRefresh(repoPath: repo), intent: .automaticEssential)
        }
    }

    // MARK: - Navigation (high frequency, shallow depth)

    /// Open (or focus) a conversation in a worktree. The desktop focuses an
    /// existing tab rather than stacking a duplicate.
    func openWorktreeConversation(worktreePath: String) {
        DiagnosticLog.log("open worktree conversation", tag: "worktree",
                          fields: ["worktree_path": worktreePath])
        send(.worktreeOpenConversation(worktreePath: worktreePath), intent: .userInitiated)
    }

    /// Open (or focus) a conversation in the integration bench.
    func openBenchConversation(repoPath: String, sourceBranch: String) {
        DiagnosticLog.log("open bench conversation", tag: "worktree",
                          fields: ["repo_path": repoPath, "source_branch": sourceBranch])
        send(.benchOpenConversation(repoPath: repoPath, sourceBranch: sourceBranch), intent: .userInitiated)
    }

    // MARK: - Worktree verbs

    /// Rebase a worktree onto its source branch. The desktop refuses a dirty
    /// worktree with an actionable message rather than a raw git error.
    func syncWorktree(_ worktree: RemoteWorktree, repoPath: String) {
        guard let sourceBranch = worktree.sourceBranch else {
            gitToast = GitToast(message: "Ion does not know what branch this worktree came from.", isError: true)
            return
        }
        worktreeBusyPath = worktree.worktreePath
        send(.worktreeSync(worktreePath: worktree.worktreePath, sourceBranch: sourceBranch, repoPath: repoPath),
             intent: .userInitiated)
    }

    /// Land a worktree into its source branch.
    func landWorktree(_ worktree: RemoteWorktree, repoPath: String) {
        guard let sourceBranch = worktree.sourceBranch else {
            gitToast = GitToast(message: "Ion does not know what branch this worktree came from.", isError: true)
            return
        }
        worktreeBusyPath = worktree.worktreePath
        send(.worktreeLand(repoPath: repoPath,
                           worktreePath: worktree.worktreePath,
                           worktreeBranch: worktree.branchName,
                           sourceBranch: sourceBranch),
             intent: .userInitiated)
    }

    // MARK: - Bench verbs

    func rebuildBench(repoPath: String, sourceBranch: String) {
        benchBusy = true
        send(.benchRebuild(repoPath: repoPath, sourceBranch: sourceBranch), intent: .userInitiated)
    }

    func updateBenchMember(repoPath: String, sourceBranch: String, worktreePath: String) {
        worktreeBusyPath = worktreePath
        send(.benchUpdateMember(repoPath: repoPath, sourceBranch: sourceBranch, worktreePath: worktreePath),
             intent: .userInitiated)
    }

    func updateAllBenchMembers(repoPath: String, sourceBranch: String) {
        benchBusy = true
        send(.benchUpdateAll(repoPath: repoPath, sourceBranch: sourceBranch), intent: .userInitiated)
    }

    func setBenchMemberEnabled(repoPath: String, sourceBranch: String, worktreePath: String, enabled: Bool) {
        send(.benchSetEnabled(repoPath: repoPath, sourceBranch: sourceBranch,
                              worktreePath: worktreePath, enabled: enabled),
             intent: .userInitiated)
    }

    func addBenchMember(repoPath: String, sourceBranch: String, worktree: RemoteWorktree) {
        send(.benchAddMember(repoPath: repoPath, sourceBranch: sourceBranch,
                             worktreePath: worktree.worktreePath, branchName: worktree.branchName),
             intent: .userInitiated)
    }

    func removeBenchMember(repoPath: String, sourceBranch: String, worktreePath: String) {
        send(.benchRemoveMember(repoPath: repoPath, sourceBranch: sourceBranch, worktreePath: worktreePath),
             intent: .userInitiated)
    }

    // MARK: - Inbound

    func handleWorktreeState(_ states: [RemoteWorktreeState]) {
        for state in states {
            worktreeStates[state.repoPath] = state
        }
        // Any state push means the operation that triggered it has finished.
        worktreeBusyPath = nil
        benchBusy = false
        DiagnosticLog.log("worktree state updated", tag: "worktree",
                          fields: ["projects": String(states.count)])
    }

    func handleWorktreeOpResult(_ result: RemoteWorktreeOpResult) {
        worktreeBusyPath = nil
        benchBusy = false
        if result.ok {
            gitToast = GitToast(message: Self.successMessage(for: result.operation), isError: false)
            return
        }
        // A refusal the operator can fix reads differently from a hard failure,
        // and the recovery differs too -- so do not collapse them.
        let message = result.error ?? "\(Self.successMessage(for: result.operation)) failed."
        gitToast = GitToast(message: message, isError: true)
        DiagnosticLog.log("worktree operation failed", tag: "worktree", level: .warn,
                          fields: [
                            "operation": result.operation.rawValue,
                            "refused_dirty": String(result.refusedDirty ?? false),
                            "has_conflicts": String(result.hasConflicts ?? false),
                            "error": result.error ?? "",
                          ])
    }

    private static func successMessage(for op: RemoteWorktreeOpResult.Operation) -> String {
        switch op {
        case .sync: return "Synced from the source branch."
        case .land: return "Landed into the source branch."
        case .rebuild: return "Bench rebuilt."
        case .update: return "Member updated and bench rebuilt."
        case .updateAll: return "All stale members updated and bench rebuilt."
        }
    }
}

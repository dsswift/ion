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
        send(.worktreeOpenConversation(worktreePath: worktreePath, newConversation: false),
             intent: .userInitiated)
    }

    /// Create an ADDITIONAL conversation in a worktree, rather than focusing one
    /// that already exists. Tapping a row does the latter; this is the row menu's
    /// explicit verb, matching the desktop's "New conversation here".
    func newWorktreeConversation(worktreePath: String) {
        send(.worktreeOpenConversation(worktreePath: worktreePath, newConversation: true),
             intent: .userInitiated)
    }

    /// Cycle through authoritative bench conversations already in this snapshot.
    /// Machine Auto-fix and Analysis tabs share the bench directory and must be
    /// visible navigation targets here. Only an empty list asks desktop to create
    /// the persistent operator singleton.
    func openBenchConversation(repoPath: String, sourceBranch: String) {
        // A missing snapshot row is treated as an empty conversation list. The
        // request still reaches desktop, which may have a fresher bench record
        // and will answer creation through the next authoritative snapshot.
        let conversations = worktreeStates[repoPath]?.benches
            .first(where: { $0.sourceBranch == sourceBranch })?.openConversations ?? []
        if !conversations.isEmpty {
            cancelPendingBenchConversation(reason: "superseded by open bench conversation")
            let current = conversations.firstIndex { $0.tabId == focusedTabId }
            let target = current.map { conversations[($0 + 1) % conversations.count] } ?? conversations[0]
            navigateToTab(target.tabId)
            DiagnosticLog.log("focused open bench conversation", tag: "worktree",
                              fields: ["repo_path": repoPath,
                                       "source_branch": sourceBranch,
                                       "tab_id": target.tabId,
                                       "tab_role": target.tabRole ?? "operator",
                                       "match_count": String(conversations.count)])
            return
        }

        cancelPendingBenchConversation(reason: "superseded by new request")
        let requestId = UUID()
        DiagnosticLog.log("creating bench conversation", tag: "worktree",
                          fields: ["repo_path": repoPath,
                                   "source_branch": sourceBranch,
                                   "request_id": requestId.uuidString])
        pendingBenchConversation = PendingBenchConversation(
            requestId: requestId, repoPath: repoPath, sourceBranch: sourceBranch, timeoutTask: nil)
        send(.benchOpenConversation(repoPath: repoPath, sourceBranch: sourceBranch), intent: .userInitiated)
        pendingBenchConversation?.timeoutTask = Task { @MainActor [weak self] in
            do {
                try await Task.sleep(for: self?.benchConversationNavigationTimeout ?? .seconds(10))
            } catch {
                return // Cancellation is expected when snapshot resolves or lifecycle ends.
            }
            self?.timeoutPendingBenchConversation(requestId: requestId)
        }
    }

    func timeoutPendingBenchConversation(requestId: UUID) {
        guard let pending = pendingBenchConversation,
              pending.requestId == requestId else { return }
        pendingBenchConversation = nil
        DiagnosticLog.log("bench conversation navigation timed out", tag: "worktree", level: .warn,
                          fields: ["repo_path": pending.repoPath,
                                   "source_branch": pending.sourceBranch,
                                   "request_id": pending.requestId.uuidString])
    }

    func cancelPendingBenchConversation(reason: String) {
        guard let pending = pendingBenchConversation else { return }
        pending.timeoutTask?.cancel()
        pendingBenchConversation = nil
        DiagnosticLog.log("bench conversation navigation cancelled", tag: "worktree",
                          fields: ["repo_path": pending.repoPath,
                                   "source_branch": pending.sourceBranch,
                                   "request_id": pending.requestId.uuidString,
                                   "reason": reason])
    }

    /// Open (or focus) the bench's ONE dedicated terminal tab.
    ///
    /// A shell rather than a conversation: building and testing the integrated
    /// stack is what the bench is for. The desktop keeps exactly one terminal per
    /// bench, so pressing this repeatedly returns to the same tab and its
    /// scrollback rather than stacking shells.
    func openBenchTerminal(repoPath: String, sourceBranch: String) {
        DiagnosticLog.log("open bench terminal", tag: "worktree",
                          fields: ["repo_path": repoPath, "source_branch": sourceBranch])
        send(.benchOpenTerminal(repoPath: repoPath, sourceBranch: sourceBranch), intent: .userInitiated)
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

    /// Sync every worktree of the repo — the desktop's bulk mechanical pass
    /// (sequential rebases with recorded-resolution replay between them). The
    /// outcome arrives as a `sync_all` op result whose `summary` the toast
    /// shows verbatim.
    func syncAllWorktrees(repoPath: String) {
        benchBusy = true
        DiagnosticLog.log("sync-all requested", tag: "worktree", fields: ["repo": repoPath])
        send(.worktreeSyncAll(repoPath: repoPath), intent: .userInitiated)
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

    func retireWorktree(_ worktree: RemoteWorktree, repoPath: String) {
        worktreeBusyPath = worktree.worktreePath
        send(.worktreeRetire(repoPath: repoPath, worktreePath: worktree.worktreePath),
             intent: .userInitiated)
    }

    /// Retire every worktree in the repo already sealed by a successful Land —
    /// mirrors the desktop's "Retire all" batch control in the Landed group.
    /// The confirmation gate lives in the view; this only sends the command.
    func retireAllLandedWorktrees(repoPath: String) {
        benchBusy = true
        DiagnosticLog.log("retire all landed worktrees requested", tag: "worktree",
                          fields: ["repo_path": repoPath])
        send(.worktreeRetireLanded(repoPath: repoPath), intent: .userInitiated)
    }

    // MARK: - Bench verbs

    func assembleBench(repoPath: String, sourceBranch: String) {
        benchBusy = true
        send(.benchAssemble(repoPath: repoPath, sourceBranch: sourceBranch), intent: .userInitiated)
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

    /// Set or clear the operator's workflow stage on a worktree. `nil` clears.
    func setWorktreeStage(repoPath: String, worktreePath: String, stage: String?) {
        send(.worktreeSetStage(repoPath: repoPath, worktreePath: worktreePath, stage: stage),
             intent: .userInitiated)
    }

    /// Move a member in the merge order.
    func reorderBenchMember(repoPath: String, sourceBranch: String, worktreePath: String, toIndex: Int) {
        send(.benchReorderMember(repoPath: repoPath, sourceBranch: sourceBranch,
                                 worktreePath: worktreePath, toIndex: toIndex),
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
        if let pending = pendingBenchConversation,
           let conversation = states.first(where: { $0.repoPath == pending.repoPath })?.benches
            .first(where: { $0.sourceBranch == pending.sourceBranch })?.openConversations.first {
            pending.timeoutTask?.cancel()
            pendingBenchConversation = nil
            navigateToTab(conversation.tabId)
            DiagnosticLog.log("bench conversation navigation resolved", tag: "worktree",
                              fields: ["repo_path": pending.repoPath,
                                       "source_branch": pending.sourceBranch,
                                       "request_id": pending.requestId.uuidString,
                                       "tab_id": conversation.tabId,
                                       "tab_role": conversation.tabRole ?? "operator"])
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
            if result.operation == .open, let tabId = result.tabId {
                navigateToTab(tabId)
                DiagnosticLog.log("worktree conversation navigation resolved", tag: "worktree",
                                  fields: ["tab_id": tabId])
                return
            }
            // A dry-run collision prediction outranks the plain success line:
            // the operation worked, but the next assembly will conflict, and
            // the operator decides now whether to resolve or keep working.
            if let warning = result.warning, !warning.isEmpty {
                gitToast = GitToast(message: warning, isError: true)
                DiagnosticLog.log("pin update predicts a collision", tag: "worktree", level: .warn,
                                  fields: ["operation": result.operation.rawValue, "warning": warning])
            } else if let retired = result.retired, result.operation == .retireAll {
                // No pre-worded summary for the batch: the count is the whole
                // story ("3 landed worktrees retired." / a plural-safe zero).
                let message = retired == 1 ? "1 landed worktree retired." : "\(retired) landed worktrees retired."
                gitToast = GitToast(message: message, isError: false)
                DiagnosticLog.log("retire-all-landed finished", tag: "worktree",
                                  fields: ["retired": String(retired)])
            } else if let summary = result.summary, !summary.isEmpty {
                // sync_all pre-words its per-worktree counts on the desktop so
                // every client says the same sentence. Conflicts surviving the
                // pass are real news even on ok:true, so they tint the toast.
                gitToast = GitToast(message: summary, isError: result.hasConflicts == true)
                DiagnosticLog.log("sync-all finished", tag: "worktree",
                                  fields: ["summary": summary,
                                           "has_conflicts": String(result.hasConflicts ?? false)])
            } else if result.operation == .retire, let recoveryRef = result.recoveryRef {
                gitToast = GitToast(message: "Worktree retired. Recovery saved at \(recoveryRef).", isError: false)
            } else if result.operation == .retire, let pruned = result.prunedBenchPaths, !pruned.isEmpty {
                let count = pruned.count
                let noun = count == 1 ? "bench" : "benches"
                gitToast = GitToast(message: "Worktree retired. \(count) empty \(noun) removed.", isError: false)
            } else {
                gitToast = GitToast(message: Self.successMessage(for: result.operation), isError: false)
            }
            return
        }
        // A refusal the operator can fix reads differently from a hard failure,
        // and the recovery differs too -- so do not collapse them. sync_all's
        // failure carries its summary when one exists (partial outcomes are
        // more useful than a bare "failed"); retire_all's failure carries the
        // count already retired for the same reason -- a batch that stopped
        // partway through is not the same outcome as one that never started.
        let message: String
        if result.operation == .retireAll, let retired = result.retired, retired > 0 {
            message = "\(result.error ?? "Retire all landed worktrees failed.") (\(retired) already retired.)"
        } else {
            message = result.error ?? result.summary
                ?? "\(Self.successMessage(for: result.operation)) failed."
        }
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
        case .open: return "Worktree conversation opened."
        case .sync: return "Synced from the source branch."
        case .land: return "Landed into the source branch."
        case .retire: return "Worktree retired."
        case .assemble: return "Bench assembled."
        case .update: return "Member updated and bench assembled."
        case .updateAll: return "All stale members updated and bench assembled."
        case .syncAll: return "All worktrees synced."
        case .retireAll: return "Landed worktrees retired."
        }
    }
}

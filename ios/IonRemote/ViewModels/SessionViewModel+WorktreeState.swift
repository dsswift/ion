import Foundation

// MARK: - Worktree + integration bench state
//
// Extracted from SessionViewModel.swift, which is at its 600-line cap. These
// are stored properties on the same @Observable view model; Swift allows them
// in an extension only via a nested storage object, so the state is held in one
// `WorktreeUIState` value and surfaced through computed accessors.
//
// The desktop computes every derived fact -- staleness, base drift, discard
// safety -- and pushes the projection. iOS renders main-process truth rather
// than deriving its own, which is what keeps the vocabulary identical across
// the desktop overlay, the Studio mirror, and here.

/// All worktree/bench UI state, held as one value so it can live in an
/// extension of the observable view model.
struct WorktreeUIState {
    /// Per-repo worktree + bench projection, keyed by repo path.
    var states: [String: RemoteWorktreeState] = [:]
    /// Cold settled history comes from desktop_snapshot. It is separate from
    /// live tabs so a review-only record does not create a live conversation.
    /// Worktree path with an operation in flight, for a per-row spinner.
    var settledTabs: [RemoteTabState] = []
    var busyPath: String?
    /// A bench-level operation (assemble / update-all) is in flight.
    var benchBusy = false
    /// One unresolved bench-conversation request. Snapshot correlation resolves
    /// it exactly once because each bench exposes one stable singleton tab ID.
    var pendingBenchConversation: PendingBenchConversation?
    /// Instance-configurable so timeout behavior can be tested without waiting.
    var benchConversationNavigationTimeout: Duration = .seconds(10)
    /// Live sync-pipeline projection per repo (desktop_worktree_pipeline).
    /// A nil phase clears the entry (pipeline dismissed on the desktop).
    var pipelines: [String: RemoteWorktreePipeline] = [:]
}

struct PendingBenchConversation {
    let requestId: UUID
    let repoPath: String
    let sourceBranch: String
    var timeoutTask: Task<Void, Never>?
}

extension SessionViewModel {

    var worktreeStates: [String: RemoteWorktreeState] {
        get { worktreeUI.states }
        set { worktreeUI.states = newValue }
    }

    var settledTabs: [RemoteTabState] {
        get { worktreeUI.settledTabs }
        set { worktreeUI.settledTabs = newValue }
    }

    var worktreeBusyPath: String? {
        get { worktreeUI.busyPath }
        set { worktreeUI.busyPath = newValue }
    }

    var benchBusy: Bool {
        get { worktreeUI.benchBusy }
        set { worktreeUI.benchBusy = newValue }
    }

    var pendingBenchConversation: PendingBenchConversation? {
        get { worktreeUI.pendingBenchConversation }
        set { worktreeUI.pendingBenchConversation = newValue }
    }

    var benchConversationNavigationTimeout: Duration {
        get { worktreeUI.benchConversationNavigationTimeout }
        set { worktreeUI.benchConversationNavigationTimeout = newValue }
    }

    var worktreePipelines: [String: RemoteWorktreePipeline] {
        get { worktreeUI.pipelines }
        set { worktreeUI.pipelines = newValue }
    }

    /// Fold one pipeline push into per-repo state. `phase == nil` is the
    /// desktop's dismissal signal and removes the banner.
    func handleWorktreePipeline(_ pipeline: RemoteWorktreePipeline) {
        if pipeline.phase == nil {
            worktreeUI.pipelines.removeValue(forKey: pipeline.repoPath)
        } else {
            worktreeUI.pipelines[pipeline.repoPath] = pipeline
        }
        DiagnosticLog.log("worktree pipeline update", tag: "worktree",
                          fields: ["repo_path": pipeline.repoPath,
                                   "phase": pipeline.phase?.rawValue ?? "dismissed",
                                   "queue": String(pipeline.queue.count),
                                   "needs_manual": String(pipeline.needsManual.count),
                                   "resolved_by_ai": String(pipeline.resolvedByAi)])
    }
}

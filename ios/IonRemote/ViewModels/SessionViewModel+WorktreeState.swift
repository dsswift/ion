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
// the desktop overlay, the ATV mirror, and here.

/// All worktree/bench UI state, held as one value so it can live in an
/// extension of the observable view model.
struct WorktreeUIState {
    /// Per-repo worktree + bench projection, keyed by repo path.
    var states: [String: RemoteWorktreeState] = [:]
    /// Worktree path with an operation in flight, for a per-row spinner.
    var busyPath: String?
    /// A bench-level operation (assemble / update-all) is in flight.
    var benchBusy = false
}

extension SessionViewModel {

    var worktreeStates: [String: RemoteWorktreeState] {
        get { worktreeUI.states }
        set { worktreeUI.states = newValue }
    }

    var worktreeBusyPath: String? {
        get { worktreeUI.busyPath }
        set { worktreeUI.busyPath = newValue }
    }

    var benchBusy: Bool {
        get { worktreeUI.benchBusy }
        set { worktreeUI.benchBusy = newValue }
    }
}

import Foundation

// MARK: - Git Commands
//
// Extracted from SessionViewModel+Commands.swift to keep that file under the
// 600-line Swift cap. These remain members of the same `extension
// SessionViewModel` and dispatch through the same `send` helper.

extension SessionViewModel {

    func requestGitChanges(directory: String) {
        send(.gitChanges(directory: directory), intent: .automaticEssential)
    }

    /// Request git changes for every unique tab working directory that doesn't
    /// already have cached data. Called when the "Show Git Info" toggle is
    /// enabled so rows populate without waiting for the next watcher event.
    func requestMissingGitChanges() {
        let dirs = Set(tabs.map(\.workingDirectory).filter { !$0.isEmpty })
        for dir in dirs where gitChanges[dir] == nil {
            requestGitChanges(directory: dir)
        }
    }

    /// Request git changes for every unique tab working directory — including
    /// ones that already have cached (potentially stale) data. Called when the
    /// app foregrounds and when the tab list appears, so the user sees fresh
    /// branch + ahead/behind info on every appear. The desktop's git watcher
    /// is best-effort and can silently stop delivering events; this guarantees
    /// the iOS tab list reflects current state.
    func requestAllGitChanges() {
        let dirs = Set(tabs.map(\.workingDirectory).filter { !$0.isEmpty })
        for dir in dirs {
            requestGitChanges(directory: dir)
        }
    }

    // The one-shot view requests below (gitGraph, gitDiff, gitCommitFiles —
    // and fsListDir in SessionViewModel+Commands.swift) send with
    // `.automaticEssential`, not `.userInitiated`: they are screen-required
    // background loads the view fires once (refresh/appear/load-more) with no
    // re-triggering call site, so a send failure during a transport gap must
    // defer to the essential queue instead of dropping the request permanently
    // (log-confirmed loss: "user command send failed, not queueable").

    func requestGitGraph(directory: String, skip: Int? = nil, limit: Int? = nil) {
        send(.gitGraph(directory: directory, skip: skip, limit: limit), intent: .automaticEssential)
    }

    func requestGitDiff(directory: String, path: String, staged: Bool) {
        gitDiffLoading = true
        send(.gitDiff(directory: directory, path: path, staged: staged), intent: .automaticEssential)
    }

    func gitStage(directory: String, paths: [String]) {
        send(.gitStage(directory: directory, paths: paths), intent: .userInitiated)
    }

    func gitUnstage(directory: String, paths: [String]) {
        send(.gitUnstage(directory: directory, paths: paths), intent: .userInitiated)
    }

    func gitCommit(directory: String, message: String) {
        send(.gitCommit(directory: directory, message: message), intent: .userInitiated)
    }

    func gitDiscard(directory: String, paths: [String]) {
        send(.gitDiscard(directory: directory, paths: paths), intent: .userInitiated)
    }

    func gitFetch(directory: String) {
        send(.gitFetch(directory: directory), intent: .userInitiated)
    }

    func gitPull(directory: String) {
        send(.gitPull(directory: directory), intent: .userInitiated)
    }

    func gitPush(directory: String) {
        send(.gitPush(directory: directory), intent: .userInitiated)
    }

    func requestGitCommitFiles(directory: String, hash: String) {
        send(.gitCommitFiles(directory: directory, hash: hash), intent: .automaticEssential)
    }

    func requestGitCommitFileDiff(directory: String, hash: String, path: String) {
        send(.gitCommitFileDiff(directory: directory, hash: hash, path: path), intent: .userInitiated)
    }
}

import Foundation

/// Where each integration bench lives, by repository and source branch.
///
/// One bench verb on the Studio wire (`benchRerereDiscardAll`) names the bench
/// by its directory, while the command that reaches it names the branch. The
/// projection the server pushes carries both, so the client keeps the pairing
/// from every worktree state it receives and the command table reads it here.
///
/// Held apart from the view model because the command table runs off the main
/// actor: this is the one piece of client state it reads.
final class StudioBenchPathIndex: @unchecked Sendable {

    private let lock = NSLock()
    private var paths: [String: String] = [:]

    /// Records every bench in a freshly received projection. Benches of other
    /// repositories are left alone, so a per-repo refresh never forgets them.
    func update(from states: [RemoteWorktreeState]) {
        lock.withLock {
            for state in states {
                for bench in state.benches {
                    paths[Self.key(state.repoPath, bench.sourceBranch)] = bench.benchPath
                }
            }
        }
    }

    /// Nil when no projection naming this bench has arrived yet.
    func path(repoPath: String, sourceBranch: String) -> String? {
        lock.withLock { paths[Self.key(repoPath, sourceBranch)] }
    }

    private static func key(_ repoPath: String, _ sourceBranch: String) -> String { "\(repoPath)\u{1}\(sourceBranch)" }
}

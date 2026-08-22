import Foundation

/// Resolves a conversation directory to the project that owns its worktrees.
/// The desktop is authoritative. This type only joins tab and worktree snapshot
/// records, including older alias-keyed records that can repeat a worktree.
enum WorktreeProjectIdentity {
    /// The explicit snapshot identity wins. Older snapshots fall back to the
    /// worktree and bench containment tables, then to the tab directory.
    static func projectPath(for tab: RemoteTabState, states: [String: RemoteWorktreeState]) -> String {
        if let repoPath = tab.worktree?.repoPath, !repoPath.isEmpty {
            return repoPath
        }
        return projectPath(forDirectory: tab.workingDirectory, states: states) ?? tab.workingDirectory
    }

    /// Returns each requested project once. An Inbox refresh must never ask the
    /// desktop to project the same Git repository through every checkout alias.
    static func refreshProjectPaths(tabs: [RemoteTabState], states: [String: RemoteWorktreeState]) -> [String] {
        var paths: [String] = []
        var seen = Set<String>()
        for tab in tabs where !tab.workingDirectory.isEmpty && tab.workingDirectory != "~" {
            let path = projectPath(for: tab, states: states)
            if !path.isEmpty && seen.insert(path).inserted {
                paths.append(path)
            }
        }
        return paths
    }

    /// The matching owner with the longest contained path. Sorting makes an
    /// alias-keyed legacy payload deterministic. It also avoids
    /// Dictionary(uniqueKeysWithValues:), which traps on repeated worktrees.
    static func projectPath(forDirectory directory: String, states: [String: RemoteWorktreeState]) -> String? {
        let candidates = states.values.flatMap { state in
            state.worktrees.map { Owner(path: $0.worktreePath, repoPath: state.repoPath) }
                + state.benches.map { Owner(path: $0.benchPath, repoPath: state.repoPath) }
        }
        return candidates
            .filter { directory == $0.path || directory.hasPrefix($0.path + "/") }
            .sorted { left, right in
                if left.path.count != right.path.count { return left.path.count > right.path.count }
                if left.repoPath != right.repoPath { return left.repoPath < right.repoPath }
                return left.path < right.path
            }
            .first?
            .repoPath
    }

    private struct Owner {
        let path: String
        let repoPath: String
    }
}

import Foundation

// MARK: - Git data types for remote git pane

/// A file with changes in the working tree.
struct GitChangedFile: Codable, Identifiable, Sendable {
    let path: String
    let status: String   // added, modified, deleted, renamed, untracked
    let staged: Bool
    let oldPath: String?

    var id: String { "\(path):\(staged)" }

    /// Single-letter badge for display.
    var statusLetter: String {
        switch status {
        case "added", "untracked": return "A"
        case "modified": return "M"
        case "deleted": return "D"
        case "renamed": return "R"
        default: return "?"
        }
    }

    /// File name without directory path.
    var fileName: String {
        (path as NSString).lastPathComponent
    }

    /// Directory portion of the path.
    var directory: String {
        let dir = (path as NSString).deletingLastPathComponent
        return dir.isEmpty ? "" : dir
    }
}

/// A ref attached to a commit.
struct GitRef: Codable, Sendable {
    let name: String
    let type: String     // head, remote, tag
    let isCurrent: Bool
}

/// A commit in the git graph.
struct GitCommitInfo: Codable, Identifiable, Sendable {
    let hash: String
    let fullHash: String
    let parents: [String]
    let authorName: String
    let authorDate: String
    let subject: String
    let refs: [GitRef]

    var id: String { fullHash }

    /// Relative date string for display.
    var relativeDate: String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        guard let date = formatter.date(from: authorDate) else { return authorDate }
        let relative = RelativeDateTimeFormatter()
        relative.unitsStyle = .abbreviated
        return relative.localizedString(for: date, relativeTo: Date())
    }
}

/// Response payload for git_changes_response.
struct GitChangesResponse: Codable, Sendable {
    let files: [GitChangedFile]
    let branch: String
    let isGitRepo: Bool
    let ahead: Int
    let behind: Int
    let stagedCount: Int?
    let unstagedCount: Int?
    
    /// Computed count with fallback to manual counting if field not present.
    var effectiveStagedCount: Int {
        stagedCount ?? files.filter(\.staged).count
    }
    
    var effectiveUnstagedCount: Int {
        unstagedCount ?? files.filter { !$0.staged }.count
    }
}

/// Response payload for git_graph_response.
struct GitGraphResponse: Codable, Sendable {
    let commits: [GitCommitInfo]
    let isGitRepo: Bool
    let totalCount: Int
    let graphLayout: [GraphLayoutEntry]?
}

/// Response payload for git_diff_response.
struct GitDiffResponse: Codable, Sendable {
    let diff: String
    let fileName: String
}

/// A file changed in a specific commit.
struct GitCommitFile: Codable, Identifiable, Sendable {
    let path: String
    let status: String   // added, modified, deleted, renamed
    let oldPath: String?
    
    var id: String { path }
    
    var fileName: String {
        (path as NSString).lastPathComponent
    }
    
    var directory: String {
        let dir = (path as NSString).deletingLastPathComponent
        return dir.isEmpty ? "" : dir
    }
    
    var statusLetter: String {
        switch status {
        case "added": return "A"
        case "modified": return "M"
        case "deleted": return "D"
        case "renamed": return "R"
        default: return "?"
        }
    }
}

/// Aggregate stats for a commit.
struct GitCommitStats: Codable, Sendable {
    let filesChanged: Int
    let insertions: Int
    let deletions: Int
}

/// Response payload for git_commit_files_response.
struct GitCommitFilesResponse: Codable, Sendable {
    let directory: String
    let hash: String
    let files: [GitCommitFile]
    let stats: GitCommitStats
}

/// Response payload for git_commit_file_diff_response.
struct GitCommitFileDiffResponse: Codable, Sendable {
    let hash: String
    let path: String
    let diff: String
    let fileName: String
}

// MARK: - Graph layout (pre-computed by desktop)

struct GraphLayoutConnection: Codable, Sendable {
    let fromLane: Int
    let toLane: Int
    let type: String   // "straight" | "merge" | "fork"
    let color: String
}

struct GraphLayoutPassThrough: Codable, Sendable {
    let lane: Int
    let color: String
}

struct GraphLayoutEntry: Codable, Sendable {
    let lane: Int
    let color: String
    let hasIncoming: Bool
    let connections: [GraphLayoutConnection]
    let passThroughLanes: [GraphLayoutPassThrough]
}

// MARK: - Mutation result responses

struct GitMutationResult: Codable, Sendable {
    let directory: String
    let ok: Bool
    let error: String?
}

// MARK: - Toast model

struct GitToast: Sendable {
    let message: String
    let isError: Bool
}

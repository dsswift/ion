import Foundation

// MARK: - Git events

extension RemoteEvent {

    /// Decode git response events.
    static func decodeGit(
        type: TypeKey,
        container: KeyedDecodingContainer<CodingKeys>
    ) throws -> RemoteEvent? {
        switch type {
        case .gitChangesResponse:
            let directory = try container.decode(String.self, forKey: .directory)
            let files = try container.decode([GitChangedFile].self, forKey: .files)
            let branch = try container.decode(String.self, forKey: .branch)
            let isGitRepo = try container.decode(Bool.self, forKey: .isGitRepo)
            let ahead = try container.decode(Int.self, forKey: .ahead)
            let behind = try container.decode(Int.self, forKey: .behind)
            let stagedCount = try container.decodeIfPresent(Int.self, forKey: .stagedCount)
            let unstagedCount = try container.decodeIfPresent(Int.self, forKey: .unstagedCount)
            let response = GitChangesResponse(
                files: files, branch: branch,
                isGitRepo: isGitRepo, ahead: ahead, behind: behind,
                stagedCount: stagedCount, unstagedCount: unstagedCount
            )
            return .gitChangesResponse(directory: directory, response: response)

        case .gitGraphResponse:
            let directory = try container.decode(String.self, forKey: .directory)
            let commits = try container.decode([GitCommitInfo].self, forKey: .commits)
            let isGitRepo = try container.decode(Bool.self, forKey: .isGitRepo)
            let totalCount = try container.decode(Int.self, forKey: .totalCount)
            let graphLayout = try container.decodeIfPresent([GraphLayoutEntry].self, forKey: .graphLayout)
            let response = GitGraphResponse(
                commits: commits, isGitRepo: isGitRepo, totalCount: totalCount,
                graphLayout: graphLayout
            )
            return .gitGraphResponse(directory: directory, response: response)

        case .gitDiffResponse:
            let diff = try container.decode(String.self, forKey: .diff)
            let fileName = try container.decode(String.self, forKey: .fileName)
            let response = GitDiffResponse(diff: diff, fileName: fileName)
            return .gitDiffResponse(response: response)

        case .gitCommitResult:
            let result = GitMutationResult(
                directory: try container.decode(String.self, forKey: .directory),
                ok: try container.decode(Bool.self, forKey: .ok),
                error: try container.decodeIfPresent(String.self, forKey: .error)
            )
            return .gitCommitResult(result)

        case .gitStageResult:
            let result = GitMutationResult(
                directory: try container.decode(String.self, forKey: .directory),
                ok: try container.decode(Bool.self, forKey: .ok),
                error: try container.decodeIfPresent(String.self, forKey: .error)
            )
            return .gitStageResult(result)

        case .gitUnstageResult:
            let result = GitMutationResult(
                directory: try container.decode(String.self, forKey: .directory),
                ok: try container.decode(Bool.self, forKey: .ok),
                error: try container.decodeIfPresent(String.self, forKey: .error)
            )
            return .gitUnstageResult(result)

        case .gitCommitFilesResponse:
            let directory = try container.decode(String.self, forKey: .directory)
            let hash = try container.decode(String.self, forKey: .hash)
            let files = try container.decode([GitCommitFile].self, forKey: .files)
            let stats = try container.decode(GitCommitStats.self, forKey: .stats)
            let response = GitCommitFilesResponse(directory: directory, hash: hash, files: files, stats: stats)
            return .gitCommitFilesResponse(response)

        case .gitCommitFileDiffResponse:
            let hash = try container.decode(String.self, forKey: .hash)
            let path = try container.decode(String.self, forKey: .path)
            let diff = try container.decode(String.self, forKey: .diff)
            let fileName = try container.decode(String.self, forKey: .fileName)
            let response = GitCommitFileDiffResponse(hash: hash, path: path, diff: diff, fileName: fileName)
            return .gitCommitFileDiffResponse(response)

        default:
            return nil
        }
    }

    /// Encode git events. Returns `true` if the receiver was a git event.
    func encodeGit(into container: inout KeyedEncodingContainer<CodingKeys>) throws -> Bool {
        switch self {
        case .gitChangesResponse(let directory, let response):
            try container.encode(TypeKey.gitChangesResponse, forKey: .type)
            try container.encode(directory, forKey: .directory)
            try container.encode(response.files, forKey: .files)
            try container.encode(response.branch, forKey: .branch)
            try container.encode(response.isGitRepo, forKey: .isGitRepo)
            try container.encode(response.ahead, forKey: .ahead)
            try container.encode(response.behind, forKey: .behind)
            try container.encodeIfPresent(response.stagedCount, forKey: .stagedCount)
            try container.encodeIfPresent(response.unstagedCount, forKey: .unstagedCount)
            return true

        case .gitGraphResponse(let directory, let response):
            try container.encode(TypeKey.gitGraphResponse, forKey: .type)
            try container.encode(directory, forKey: .directory)
            try container.encode(response.commits, forKey: .commits)
            try container.encode(response.isGitRepo, forKey: .isGitRepo)
            try container.encode(response.totalCount, forKey: .totalCount)
            try container.encodeIfPresent(response.graphLayout, forKey: .graphLayout)
            return true

        case .gitDiffResponse(let response):
            try container.encode(TypeKey.gitDiffResponse, forKey: .type)
            try container.encode(response.diff, forKey: .diff)
            try container.encode(response.fileName, forKey: .fileName)
            return true

        case .gitCommitResult(let result):
            try container.encode(TypeKey.gitCommitResult, forKey: .type)
            try container.encode(result.directory, forKey: .directory)
            try container.encode(result.ok, forKey: .ok)
            try container.encodeIfPresent(result.error, forKey: .error)
            return true

        case .gitStageResult(let result):
            try container.encode(TypeKey.gitStageResult, forKey: .type)
            try container.encode(result.directory, forKey: .directory)
            try container.encode(result.ok, forKey: .ok)
            try container.encodeIfPresent(result.error, forKey: .error)
            return true

        case .gitUnstageResult(let result):
            try container.encode(TypeKey.gitUnstageResult, forKey: .type)
            try container.encode(result.directory, forKey: .directory)
            try container.encode(result.ok, forKey: .ok)
            try container.encodeIfPresent(result.error, forKey: .error)
            return true

        case .gitCommitFilesResponse(let response):
            try container.encode(TypeKey.gitCommitFilesResponse, forKey: .type)
            try container.encode(response.directory, forKey: .directory)
            try container.encode(response.hash, forKey: .hash)
            try container.encode(response.files, forKey: .files)
            try container.encode(response.stats, forKey: .stats)
            return true

        case .gitCommitFileDiffResponse(let response):
            try container.encode(TypeKey.gitCommitFileDiffResponse, forKey: .type)
            try container.encode(response.hash, forKey: .hash)
            try container.encode(response.path, forKey: .path)
            try container.encode(response.diff, forKey: .diff)
            try container.encode(response.fileName, forKey: .fileName)
            return true

        default:
            return false
        }
    }
}

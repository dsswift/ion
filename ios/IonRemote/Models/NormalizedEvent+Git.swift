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
            let response = GitChangesResponse(
                files: files, branch: branch,
                isGitRepo: isGitRepo, ahead: ahead, behind: behind
            )
            return .gitChangesResponse(directory: directory, response: response)

        case .gitGraphResponse:
            let directory = try container.decode(String.self, forKey: .directory)
            let commits = try container.decode([GitCommitInfo].self, forKey: .commits)
            let isGitRepo = try container.decode(Bool.self, forKey: .isGitRepo)
            let totalCount = try container.decode(Int.self, forKey: .totalCount)
            let response = GitGraphResponse(
                commits: commits, isGitRepo: isGitRepo, totalCount: totalCount
            )
            return .gitGraphResponse(directory: directory, response: response)

        case .gitDiffResponse:
            let diff = try container.decode(String.self, forKey: .diff)
            let fileName = try container.decode(String.self, forKey: .fileName)
            let response = GitDiffResponse(diff: diff, fileName: fileName)
            return .gitDiffResponse(response: response)

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
            return true

        case .gitGraphResponse(let directory, let response):
            try container.encode(TypeKey.gitGraphResponse, forKey: .type)
            try container.encode(directory, forKey: .directory)
            try container.encode(response.commits, forKey: .commits)
            try container.encode(response.isGitRepo, forKey: .isGitRepo)
            try container.encode(response.totalCount, forKey: .totalCount)
            return true

        case .gitDiffResponse(let response):
            try container.encode(TypeKey.gitDiffResponse, forKey: .type)
            try container.encode(response.diff, forKey: .diff)
            try container.encode(response.fileName, forKey: .fileName)
            return true

        default:
            return false
        }
    }
}

import Foundation

/// The git and filesystem replies. Each read answers the whole response the
/// `desktop_*` wire pushed under its own event name; each write answers
/// `{ok, error}` and is followed by the read that refreshes what it changed
/// (`next(for:after:result:)`).
extension StudioTransportCommandMapping {

    /// Nil means this command is not a git command, so the caller keeps looking.
    // swiftlint:disable:next cyclomatic_complexity
    static func gitEvents(for command: RemoteCommand, call: StudioActionCall, result: JSONValue) -> [RemoteEvent]? {
        switch command {
        case .gitChanges(let directory):
            return changes(directory, result)
        case .gitBranches(let directory):
            guard let response = decode(result, as: GitBranchesResponse.self, what: "git branches") else { return [] }
            return [.gitBranchesResponse(directory: directory, response: response)]
        case .gitGraph(let directory, _, _):
            return graph(directory, result)
        case .gitDiff:
            guard let response = decode(result, as: GitDiffResponse.self, what: "git diff") else { return [] }
            return [.gitDiffResponse(response: response)]
        case .gitStage(let directory, _):
            return [.gitStageResult(mutation(directory, result))]
        case .gitUnstage(let directory, _):
            return [.gitUnstageResult(mutation(directory, result))]
        case .gitCommit(let directory, _):
            return [.gitCommitResult(mutation(directory, result))]
        case .gitDiscard(let directory, _), .gitFetch(let directory), .gitPull(let directory), .gitPush(let directory):
            // These carried no result event on the older wire; the refresh is
            // the reply. A failure still surfaces (see `gitFailureEvents`).
            if call.action == "git.changes" { return changes(directory, result) }
            if call.action == "git.graph" { return graph(directory, result) }
            guard result["ok"]?.boolValue == false else { return [] }
            return [.gitCommitResult(mutation(directory, result))]
        case .gitCommitFiles(let directory, let hash):
            let files = decode(result["files"] ?? .array([]), as: [GitCommitFile].self, what: "commit files") ?? []
            guard let stats = decode(result["stats"] ?? .null, as: GitCommitStats.self, what: "commit stats") else { return [] }
            return [.gitCommitFilesResponse(GitCommitFilesResponse(directory: directory, hash: hash, files: files, stats: stats))]
        case .gitCommitFileDiff(_, let hash, let path):
            return [.gitCommitFileDiffResponse(GitCommitFileDiffResponse(
                hash: hash, path: path, diff: result["diff"]?.stringValue ?? "",
                fileName: result["fileName"]?.stringValue ?? path,
                isBinary: result["isBinary"]?.boolValue ?? false))]
        default:
            // A refresh read runs under the command that wrote, so the write's
            // own case above is the only place that names these actions.
            return nil
        }
    }

    /// A git write that failed outright reads the same as one the server
    /// refused: the panel shows the reason rather than nothing.
    static func gitFailureEvents(for command: RemoteCommand, call: StudioActionCall, message: String) -> [RemoteEvent]? {
        guard call.action.hasPrefix("git.") else { return nil }
        switch command {
        case .gitStage(let directory, _):
            return [.gitStageResult(GitMutationResult(directory: directory, ok: false, error: message))]
        case .gitUnstage(let directory, _):
            return [.gitUnstageResult(GitMutationResult(directory: directory, ok: false, error: message))]
        case .gitCommit(let directory, _), .gitDiscard(let directory, _), .gitFetch(let directory),
             .gitPull(let directory), .gitPush(let directory):
            return [.gitCommitResult(GitMutationResult(directory: directory, ok: false, error: message))]
        default:
            return nil
        }
    }

    /// Nil means this command is not a filesystem command. The paths come from
    /// the command: the server answers the outcome, not the target.
    static func fileEvents(for command: RemoteCommand, result: JSONValue) -> [RemoteEvent]? {
        let error = result["error"]?.stringValue
        switch command {
        case .fsListDir(let directory, _):
            let entries: [FsEntry]
            if let listed = result["entries"] {
                guard let decoded = decode(listed, as: [FsEntry].self, what: "directory listing") else {
                    return [.fsDirListing(directory: directory, response: FsDirListingResponse(
                        directory: directory, entries: [], error: "The directory listing could not be read."))]
                }
                entries = decoded
            } else {
                entries = []
            }
            return [.fsDirListing(directory: directory, response: FsDirListingResponse(
                directory: directory, entries: entries, error: error))]
        case .fsReadFile(let filePath):
            return [.fsFileContent(filePath: filePath, response: FsFileContentResponse(
                filePath: filePath, content: result["content"]?.stringValue, error: error))]
        case .fsReadImage(let filePath):
            return [.fsImageContent(filePath: filePath, dataUrl: result["dataUrl"]?.stringValue, error: error)]
        case .fsWriteFile(let filePath, _):
            return [.fsWriteResult(filePath: filePath, response: FsWriteResultResponse(
                filePath: filePath, ok: result["ok"]?.boolValue ?? false, error: error))]
        case .fsRename(let oldPath, let newPath):
            return [.fsRenameResult(oldPath: oldPath, newPath: newPath, response: FsRenameResultResponse(
                oldPath: oldPath, newPath: newPath, ok: result["ok"]?.boolValue ?? false, error: error))]
        default:
            return nil
        }
    }

    // MARK: - Shared shapes

    private static func changes(_ directory: String, _ result: JSONValue) -> [RemoteEvent] {
        guard let response = decode(result, as: GitChangesResponse.self, what: "git changes") else { return [] }
        return [.gitChangesResponse(directory: directory, response: response)]
    }

    private static func graph(_ directory: String, _ result: JSONValue) -> [RemoteEvent] {
        guard let response = decode(result, as: GitGraphResponse.self, what: "git graph") else { return [] }
        return [.gitGraphResponse(directory: directory, response: response)]
    }

    /// `{ok, error}` as the mutation result the panel renders. The directory
    /// comes from the command: the server answers the outcome, not the target.
    private static func mutation(_ directory: String, _ result: JSONValue) -> GitMutationResult {
        GitMutationResult(
            directory: directory, ok: result["ok"]?.boolValue ?? false, error: result["error"]?.stringValue)
    }
}

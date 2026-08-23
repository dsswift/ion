import Foundation

// Handlers for the git-panel and file-explorer event group extracted from
// SessionViewModel+EventHandlers.swift to keep that file under the 600-line
// cap. Each function is a straight lift of the switch-case body that used to
// live inline in handleEvent(_:) — no behavior change, just a new home.
extension SessionViewModel {
    // MARK: - Git events

    @MainActor
    func handleGitChangesResponse(directory: String, response: GitChangesResponse) {
        gitChanges[directory] = response
    }

    @MainActor
    func handleGitGraphResponse(directory: String, response: GitGraphResponse) {
        gitGraph[directory] = response
    }

    @MainActor
    func handleGitDiffResponse(_ response: GitDiffResponse) {
        gitDiffResult = response
        gitDiffLoading = false
    }

    @MainActor
    func handleGitCommitResult(_ result: GitMutationResult) {
        if result.ok {
            Haptic.success()
            gitToast = GitToast(message: "Committed successfully", isError: false)
        } else {
            Haptic.error()
            gitToast = GitToast(message: result.error ?? "Commit failed", isError: true)
        }
    }

    @MainActor
    func handleGitStageResult(_ result: GitMutationResult) {
        if result.ok {
            Haptic.success()
        } else {
            Haptic.error()
            gitToast = GitToast(message: result.error ?? "Stage failed", isError: true)
        }
    }

    @MainActor
    func handleGitUnstageResult(_ result: GitMutationResult) {
        if result.ok {
            Haptic.success()
        } else {
            Haptic.error()
            gitToast = GitToast(message: result.error ?? "Unstage failed", isError: true)
        }
    }

    @MainActor
    func handleGitCommitFilesResponse(_ response: GitCommitFilesResponse) {
        gitCommitFiles[response.hash] = response
    }

    @MainActor
    func handleGitCommitFileDiffResponse(_ response: GitCommitFileDiffResponse) {
        let key = "\(response.hash):\(response.path)"
        gitCommitFileDiff[key] = response
    }

    // MARK: - File explorer events

    @MainActor
    func handleFsDirListing(directory: String, response: FsDirListingResponse) {
        fileListings[directory] = response
        fileListingLoading.remove(directory)
    }

    @MainActor
    func handleFsFileContent(filePath: String, response: FsFileContentResponse) {
        fileContent[filePath] = response
        fileContentLoading.remove(filePath)
    }

    @MainActor
    func handleFsImageContent(filePath: String, dataUrl: String?) {
        RemoteImageFetcher.shared.deliver(path: filePath, dataUrl: dataUrl)
    }

    @MainActor
    func handleFsWriteResult(_ response: FsWriteResultResponse) {
        fileWriteResult = response
    }

    // Lightweight pattern mirroring `.fsWriteResult`:
    //   - publish the response so the view can surface errors,
    //   - on success, re-issue `fsListDir` on the parent dir of
    //     newPath so the listing reflects the rename. We don't
    //     also refresh oldPath's parent because the desktop
    //     handler only ever changes basename, so the parents
    //     match. If a future variant ever moves across
    //     directories, this is the spot to add the second
    //     refresh.
    @MainActor
    func handleFsRenameResult(newPath: String, response: FsRenameResultResponse) {
        fileRenameResult = response
        if response.ok {
            let parent = (newPath as NSString).deletingLastPathComponent
            if !parent.isEmpty {
                requestFsListDir(directory: parent)
            }
        }
    }
}

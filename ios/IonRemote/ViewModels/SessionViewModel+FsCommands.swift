import Foundation

// MARK: - File Explorer Commands
//
// Extracted from SessionViewModel+Commands.swift to keep that file under the
// 600-line Swift cap. These remain members of the same `extension
// SessionViewModel` and dispatch through the same `send` helper.

extension SessionViewModel {

    /// Upload an image from the iOS device to the desktop as a temp file.
    func uploadAttachment(dataUrl: String, name: String, correlationId: String) {
        send(.uploadAttachment(dataUrl: dataUrl, name: name, correlationId: correlationId), intent: .userInitiated)
    }

    func requestFsListDir(directory: String, includeHidden: Bool = false) {
        fileListingLoading.insert(directory)
        // `.automaticEssential`, not `.userInitiated`: a screen-required
        // one-shot load with no re-triggering call site — a send failure
        // during a transport gap must defer to the essential queue rather
        // than drop the listing permanently. See the matching comment in
        // SessionViewModel+GitCommands.swift.
        send(.fsListDir(directory: directory, includeHidden: includeHidden), intent: .automaticEssential)
    }

    func requestFsReadFile(filePath: String) {
        fileContentLoading.insert(filePath)
        send(.fsReadFile(filePath: filePath), intent: .userInitiated)
    }

    func requestFsWriteFile(filePath: String, content: String) {
        send(.fsWriteFile(filePath: filePath, content: content), intent: .userInitiated)
    }

    /// Rename a file or directory on the paired desktop. Fire-and-forget;
    /// the result arrives as `.fsRenameResult` which the event handler
    /// turns into a refreshed `fsListDir` on the parent directory of
    /// `newPath` (and surfaces errors via `fileRenameResult`).
    func requestFsRename(oldPath: String, newPath: String) {
        send(.fsRename(oldPath: oldPath, newPath: newPath), intent: .userInitiated)
    }

    func requestLoadAttachments(tabId: String) {
        let oldCount = tabAttachmentCache[tabId]?.count ?? -1
        DiagnosticLog.log("request load attachments", tag: "session.commands", fields: [
            "tab_id": String(tabId.prefix(8)),
            "count": String(oldCount)
        ])
        tabAttachmentCache.removeValue(forKey: tabId)
        send(.loadAttachments(tabId: tabId), intent: .automaticEssential)
    }
}

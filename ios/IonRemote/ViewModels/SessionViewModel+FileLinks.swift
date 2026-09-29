import Foundation

// MARK: - File links
//
// A long press or tap on a file path in a message. The path belongs to the
// server that owns the conversation, so that server resolves it (its own
// home for `~/`, the working directory for a relative path), and a file the
// phone shows through Quick Look or saves to Files comes over as bytes first.

extension SessionViewModel {

    @MainActor
    func fileLinkOutcome(tabId: String, path: String, cwd: String, request: FileLinkRequest) async -> FileLinkOutcome {
        let fields = ["tab_id": String(tabId.prefix(8)), "path": path, "request": request.rawValue]
        guard let live = transport as? StudioTransport else {
            DiagnosticLog.log("file link: no live connection", tag: "file-link", level: .warn, fields: fields)
            showToast(ToastMessage(style: .error, title: "Not connected", detail: "Connect to the server to open \((path as NSString).lastPathComponent)."))
            return .none
        }
        let client = ServerAdminClient(serverLabel: activeDevice?.displayName ?? "The server", caller: live)
        return await fileLinkOutcome(client: client, tabId: tabId, path: path, cwd: cwd, request: request)
    }

    /// The same, through `client`: the seam a test drives with a fake server.
    @MainActor
    func fileLinkOutcome(client: ServerAdminClient, tabId: String, path: String, cwd: String, request: FileLinkRequest) async -> FileLinkOutcome {
        let fields = ["tab_id": String(tabId.prefix(8)), "path": path, "request": request.rawValue]
        do {
            let target = try await client.resolveFileLink(tabId: tabId, path: path, cwd: cwd)
            let name = (target.path as NSString).lastPathComponent
            guard target.exists else {
                DiagnosticLog.log("file link: target missing", tag: "file-link", fields: fields.merging(["resolved": target.path]) { $1 })
                showToast(ToastMessage(style: .warning, title: "File not found", detail: target.path.isEmpty ? path : target.path))
                return .none
            }
            guard !target.isDirectory else {
                showToast(ToastMessage(style: .info, title: "That is a folder", detail: target.path))
                return .none
            }
            let kind = FileLinkKind.of(target.path)
            let wantsExport = request == .download || (request == .open && !kind.canPreview)
            DiagnosticLog.log("file link: resolved", tag: "file-link", fields: fields.merging([
                "resolved": target.path, "kind": String(describing: kind), "export": String(wantsExport), "size": String(target.size)
            ]) { $1 })
            if !wantsExport && kind == .text { return .showText(path: target.path) }
            guard target.size <= ServerAdminClient.maxFileDataBytes else {
                let megabytes = target.size / (1024 * 1024)
                showToast(ToastMessage(style: .error, title: "File too large", detail: "\(name) is \(megabytes) MB. Files over 25 MB cannot be copied to this phone."))
                return .none
            }
            guard let data = try await client.readFileData(tabId: tabId, filePath: target.path) else {
                DiagnosticLog.log("file link: server sent no bytes", tag: "file-link", level: .warn, fields: fields)
                showToast(ToastMessage(style: .error, title: "Could not open \(name)", detail: "The server did not send the file."))
                return .none
            }
            let copy = try RemoteFileCopy.write(data, name: name)
            DiagnosticLog.log("file link: local copy written", tag: "file-link", fields: fields.merging(["bytes": String(data.count)]) { $1 })
            return wantsExport ? .export(copy) : .quickLook(copy)
        } catch {
            DiagnosticLog.log("file link: failed", tag: "file-link", level: .error, fields: fields.merging(["error": String(String(describing: error).prefix(300))]) { $1 })
            showToast(ToastMessage(style: .error, title: "Could not open \((path as NSString).lastPathComponent)", detail: error.localizedDescription))
            return .none
        }
    }
}

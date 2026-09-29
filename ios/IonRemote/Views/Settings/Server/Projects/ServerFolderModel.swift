import Foundation
import Observation

/// One walk through a server's folders: the path typed or reached, and the
/// folders under it, listed by the server from its own disk.
@MainActor
@Observable
final class ServerFolderModel {
    /// What the path field shows; submitting it lists that folder.
    var typedPath: String
    var showHidden = false
    private(set) var listing: EnvironmentFsBrowse?
    private(set) var loading = false
    private(set) var error: String?

    @ObservationIgnored private let serverId: String
    @ObservationIgnored private let client: ServerAdminClient

    init(serverId: String, client: ServerAdminClient, initialPath: String) {
        self.serverId = serverId
        self.client = client
        self.typedPath = initialPath
    }

    /// Lists what the path field says.
    func browseTyped() async { await browse(typedPath) }

    func goHome() async { await browse("~") }

    func goUp() async {
        guard let parent = listing?.parentPath else { return }
        await browse(parent)
    }

    func descend(into entry: EnvironmentFsBrowse.Entry) async { await browse(entry.fullPath) }

    /// Lists `path`. On success the path field shows the resolved path.
    func browse(_ path: String) async {
        let requested = CloneBaseDirectory.normalized(path)
        loading = true
        defer { loading = false }
        do {
            let result = try await client.browse(path: requested.isEmpty ? "~" : requested, showHidden: showHidden)
            listing = result
            typedPath = result.path
            error = nil
            DiagnosticLog.log("folders: listed", tag: "admin.projects", level: .debug, fields: [
                "server_id": serverId, "entries": String(result.entries.count), "show_hidden": String(showHidden)
            ])
        } catch is CancellationError {
            return
        } catch {
            self.error = error.localizedDescription
            DiagnosticLog.log("folders: listing failed", tag: "admin.projects", level: .warn, fields: [
                "server_id": serverId, "error": error.localizedDescription
            ])
        }
    }
}

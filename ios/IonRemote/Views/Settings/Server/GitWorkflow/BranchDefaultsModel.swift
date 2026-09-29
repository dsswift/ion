import Foundation
import Observation

/// The saved source branch per directory for this person on one server.
/// Removing one brings the branch picker back for that directory.
@MainActor
@Observable
final class BranchDefaultsModel {

    struct Entry: Equatable, Identifiable {
        let directory: String
        let branch: String
        var id: String { directory }
    }

    let serverId: String
    /// Nil until the first read lands.
    private(set) var defaults: [String: String]?
    private(set) var loadError: String?
    var operationError: String?

    @ObservationIgnored private let client: ServerAdminClient

    init(serverId: String, client: ServerAdminClient) {
        self.serverId = serverId
        self.client = client
    }

    convenience init(session: ServerAdminSession) {
        self.init(serverId: session.serverId, client: session.client)
    }

    /// The defaults by directory, in path order.
    var entries: [Entry]? {
        defaults.map { map in map.map { Entry(directory: $0.key, branch: $0.value) }.sorted { $0.directory < $1.directory } }
    }

    func load() async {
        do {
            let loaded = try await client.worktreeBranchDefaults()
            defaults = loaded
            loadError = nil
            DiagnosticLog.log("git workflow: branch defaults read", tag: "admin.git-workflow", level: .debug, fields: [
                "server_id": serverId, "count": String(loaded.count)
            ])
        } catch is CancellationError {
            return
        } catch {
            loadError = error.localizedDescription
            DiagnosticLog.log("git workflow: branch defaults read failed", tag: "admin.git-workflow", level: .warn, fields: [
                "server_id": serverId, "error": error.localizedDescription
            ])
        }
    }

    func remove(directory: String) async {
        guard var next = defaults, next[directory] != nil else { return }
        next.removeValue(forKey: directory)
        operationError = nil
        do {
            try await client.saveWorktreeBranchDefaults(next)
            defaults = next
            DiagnosticLog.log("git workflow: branch default removed", tag: "admin.git-workflow", fields: [
                "server_id": serverId, "remaining": String(next.count)
            ])
        } catch {
            operationError = error.localizedDescription
            DiagnosticLog.log("git workflow: branch default removal failed", tag: "admin.git-workflow", level: .warn, fields: [
                "server_id": serverId, "error": error.localizedDescription
            ])
        }
    }

    /// A home-relative path reads shorter: `/Users/me/src` → `~/src`.
    static func shortened(_ path: String) -> String {
        guard let match = path.range(of: "^/(Users|home)/[^/]+", options: .regularExpression) else { return path }
        return "~" + String(path[match.upperBound...])
    }
}

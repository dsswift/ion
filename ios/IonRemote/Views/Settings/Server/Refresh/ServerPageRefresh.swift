import SwiftUI

/// The pull to refresh of one server page. Each section that loads data
/// registers its reload while it is on screen; a pull runs every registered
/// reload at once and ends when the last one finishes.
@MainActor
final class ServerPageRefresh {
    typealias Reload = @MainActor @Sendable () async -> Void

    let serverId: String
    let pageId: String
    private var reloads: [String: Reload] = [:]

    init(serverId: String, pageId: String) {
        self.serverId = serverId
        self.pageId = pageId
    }

    /// The ids of the sections a pull reloads now, sorted.
    var registeredIds: [String] { reloads.keys.sorted() }

    /// A section came on screen. A second registration under the same id replaces the first.
    func register(_ id: String, reload: @escaping Reload) {
        reloads[id] = reload
    }

    /// A section left the screen.
    func unregister(_ id: String) {
        reloads[id] = nil
    }

    func refresh() async {
        let pending = reloads
        DiagnosticLog.log("server page: refresh started", tag: "settings.server", fields: [
            "server_id": serverId, "page": pageId, "sections": pending.keys.sorted().joined(separator: ",")
        ])
        await withTaskGroup(of: Void.self) { group in
            for reload in pending.values {
                group.addTask { await reload() }
            }
        }
        DiagnosticLog.log("server page: refresh finished", tag: "settings.server", fields: [
            "server_id": serverId, "page": pageId, "count": String(pending.count)
        ])
    }
}

extension EnvironmentValues {
    /// The refresh of the server page a view sits on. Nil outside one.
    @Entry var serverPageRefresh: ServerPageRefresh?
}

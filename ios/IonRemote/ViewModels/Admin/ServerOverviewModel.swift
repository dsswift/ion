import Foundation
import Observation

/// The Overview page of one server: its facts, and restarting or updating
/// its services.
@MainActor
@Observable
final class ServerOverviewModel {

    private(set) var info: EnvironmentServerInfo?
    private(set) var loading = false
    /// Why the facts could not be read, in plain words.
    private(set) var error: String?
    /// What the last restart or update request did.
    private(set) var lifecycleNotice: String?
    private(set) var lifecycleError: String?
    private(set) var lifecycleBusy = false

    @ObservationIgnored private let client: ServerAdminClient

    init(client: ServerAdminClient) {
        self.client = client
    }

    var serverLabel: String { client.serverLabel }

    /// True when the server was installed from a bundle, the only kind this
    /// phone may restart, update, or uninstall. False until the facts load.
    var isBundleInstall: Bool { info?.bundle != nil }

    func load() async {
        loading = true
        defer { loading = false }
        do {
            let loaded = try await client.serverInfo()
            info = loaded
            error = nil
            DiagnosticLog.log("overview: server facts loaded", tag: "settings.overview", level: .debug, fields: [
                "server": client.serverLabel, "bundle": String(loaded.bundle != nil)
            ])
        } catch {
            self.error = error.localizedDescription
            DiagnosticLog.log("overview: server facts failed", tag: "settings.overview", level: .warn, fields: [
                "server": client.serverLabel, "error": String(describing: error)
            ])
        }
    }

    func restart() async {
        await schedule("restart", done: "Restart scheduled") { try await $0.restartServer() }
    }

    func update() async {
        await schedule("update", done: "Update scheduled") { try await $0.updateServer() }
    }

    private func schedule(_ operation: String, done: String, _ run: (ServerAdminClient) async throws -> Void) async {
        lifecycleBusy = true
        lifecycleNotice = nil
        lifecycleError = nil
        defer { lifecycleBusy = false }
        do {
            try await run(client)
            lifecycleNotice = "\(done). \(client.serverLabel) will drop and reconnect in a moment."
            DiagnosticLog.log("overview: studio command scheduled", tag: "settings.overview", fields: [
                "server": client.serverLabel, "operation": operation
            ])
        } catch {
            lifecycleError = error.localizedDescription
            DiagnosticLog.log("overview: studio command failed", tag: "settings.overview", level: .warn, fields: [
                "server": client.serverLabel, "operation": operation, "error": String(describing: error)
            ])
        }
    }
}

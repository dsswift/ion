import Foundation
import Observation

/// Whether one server announces itself on its local network, and the verbs
/// that change it.
@MainActor
@Observable
final class DiscoveryAdminModel {

    /// The windows a person can open.
    static let windows: [(minutes: Int, label: String)] = [(15, "15 minutes"), (60, "1 hour")]

    private(set) var status: EnvironmentDiscoveryStatus?
    private(set) var loadError: String?
    private(set) var actionError: String?
    private(set) var busy = false
    /// A code minted on an always discoverable server.
    private(set) var mintedCode: DiscoveryMintedCode?

    @ObservationIgnored private let client: ServerAdminClient
    @ObservationIgnored private let serverId: String
    @ObservationIgnored private let events: ServerAdminEvents

    init(client: ServerAdminClient, serverId: String, events: ServerAdminEvents = .shared) {
        self.client = client
        self.serverId = serverId
        self.events = events
    }

    func load() async {
        do {
            status = try await client.discoveryStatus()
            loadError = nil
        } catch {
            loadError = AdminFailureText.describe(error)
            DiagnosticLog.log("discovery: status read failed", tag: "admin.access", level: .warn, fields: [
                "server_id": serverId, "error": AdminFailureText.code(error)
            ])
        }
    }

    /// Re-reads the status on every change the server announces (a window
    /// closing itself included), until the caller's task is cancelled. The
    /// announcement never carries the code, so the status is read again.
    func watch() async {
        for await event in events.events(for: serverId) where event.channel == ServerAdminEvent.discovery {
            await load()
        }
    }

    func open(minutes: Int) async {
        await run("window opened") { self.status = try await self.client.discoveryOpen(minutes: minutes) }
    }

    func close() async {
        await run("window closed") { self.status = try await self.client.discoveryClose() }
    }

    func mintCode() async {
        await run("code minted") { self.mintedCode = try await self.client.discoveryMintCode() }
    }

    private func run(_ what: String, _ body: () async throws -> Void) async {
        busy = true
        actionError = nil
        defer { busy = false }
        do {
            try await body()
            DiagnosticLog.log("discovery: action done", tag: "admin.access", fields: [
                "server_id": serverId, "action": what, "mode": status?.mode.rawValue ?? ""
            ])
        } catch {
            actionError = AdminFailureText.describe(error)
            DiagnosticLog.log("discovery: action failed", tag: "admin.access", level: .warn, fields: [
                "server_id": serverId, "action": what, "error": AdminFailureText.code(error)
            ])
        }
    }
}

import Foundation
import Observation

/// The devices paired to one server, kept current while its page is open.
@MainActor
@Observable
final class DevicesAdminModel {

    /// Live pairings, most recently seen first. Empty until `loaded`.
    private(set) var clients: [PairedClient] = []
    /// True once the list has been read at least once.
    private(set) var loaded = false
    private(set) var loading = false
    /// Why the list could not be read.
    private(set) var loadError: String?
    /// Why the last revoke failed.
    private(set) var revokeError: String?
    /// The pairing being revoked now.
    private(set) var revokingId: String?

    /// The pairing this phone rides for this server. Never revocable here.
    let ownClientId: String
    @ObservationIgnored private let client: ServerAdminClient
    @ObservationIgnored private let serverId: String
    @ObservationIgnored private let events: ServerAdminEvents

    init(client: ServerAdminClient, serverId: String, ownClientId: String, events: ServerAdminEvents = .shared) {
        self.client = client
        self.serverId = serverId
        self.ownClientId = ownClientId
        self.events = events
    }

    func isOwn(_ paired: PairedClient) -> Bool { paired.clientId == ownClientId }

    func load() async {
        loading = true
        defer { loading = false }
        do {
            let all = try await client.listClients()
            clients = all.filter { !$0.isRevoked }.sorted { $0.lastSeen > $1.lastSeen }
            loaded = true
            loadError = nil
            DiagnosticLog.log("devices: list read", tag: "admin.access", level: .debug, fields: [
                "server_id": serverId, "count": String(clients.count)
            ])
        } catch {
            loadError = AdminFailureText.describe(error)
            DiagnosticLog.log("devices: list read failed", tag: "admin.access", level: .warn, fields: [
                "server_id": serverId, "error": AdminFailureText.code(error)
            ])
        }
    }

    /// Re-reads the list whenever the server says its pairings changed, or a
    /// discovery code was used, until the caller's task is cancelled.
    func watch() async {
        for await event in events.events(for: serverId) {
            guard event.channel == ServerAdminEvent.clientsChanged || event.channel == ServerAdminEvent.discovery else { continue }
            DiagnosticLog.log("devices: server announced a change, re-reading", tag: "admin.access", level: .debug, fields: [
                "server_id": serverId, "channel": event.channel
            ])
            await load()
        }
    }

    /// Revokes one pairing. The server ends that device's live sessions now.
    /// Returns true when it is gone.
    @discardableResult
    func revoke(_ paired: PairedClient) async -> Bool {
        guard !isOwn(paired) else {
            DiagnosticLog.log("devices: revoke of this phone's own pairing refused", tag: "admin.access", level: .warn, fields: [
                "server_id": serverId
            ])
            revokeError = Self.ownPairingReason
            return false
        }
        revokingId = paired.clientId
        revokeError = nil
        defer { revokingId = nil }
        do {
            let result = try await client.revokeClient(paired.clientId)
            DiagnosticLog.log("devices: pairing revoked", tag: "admin.access", fields: [
                "server_id": serverId, "kind": paired.kind.rawValue, "revoked": String(result.revoked), "sessions_closed": String(result.closed)
            ])
            clients.removeAll { $0.clientId == paired.clientId }
            await load()
            return true
        } catch {
            revokeError = AdminFailureText.describe(error)
            DiagnosticLog.log("devices: revoke failed", tag: "admin.access", level: .warn, fields: [
                "server_id": serverId, "error": AdminFailureText.code(error)
            ])
            return false
        }
    }

    static let ownPairingReason = "This phone reaches the server through this pairing. Remove this server from the phone instead."
}

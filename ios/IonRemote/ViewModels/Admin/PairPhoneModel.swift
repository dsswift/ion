import Foundation
import Observation

/// Pairs another phone with a server: a QR code of a fresh pairing link, and
/// the typed code when the server can offer one. It finishes when a new
/// pairing appears, when the link expires, or when the person cancels. A
/// discovery window it opened to get a code is closed again however it ends.
@MainActor
@Observable
final class PairPhoneModel {

    enum Outcome: String, Equatable, Sendable {
        case paired, expired, cancelled
    }

    struct Offer: Equatable, Sendable {
        let url: String
        let expiresAt: Date
        /// The eight-character code, or nil when the server would not give one.
        let code: String?
    }

    /// How long the server stays discoverable when this has to open that window itself.
    static let discoveryMinutes = 15

    private(set) var offer: Offer?
    private(set) var error: String?
    private(set) var outcome: Outcome?

    @ObservationIgnored private let client: ServerAdminClient
    @ObservationIgnored private let serverId: String
    @ObservationIgnored private let events: ServerAdminEvents
    /// The pairings that existed before anything was offered.
    @ObservationIgnored private var known: Set<String>?
    @ObservationIgnored private(set) var openedWindow = false

    init(client: ServerAdminClient, serverId: String, events: ServerAdminEvents = .shared) {
        self.client = client
        self.serverId = serverId
        self.events = events
    }

    /// Mints the link and finds a code.
    func start() async {
        guard offer == nil, outcome == nil else { return }
        do {
            known = Set(try await client.listClients().map(\.clientId))
            // No scopes: the new phone gets the server's own pairing defaults, like any device it pairs.
            let link = try await client.createPairingLink(label: "Phone")
            let code = await obtainCode()
            guard outcome == nil else { return }
            offer = Offer(url: link.url, expiresAt: link.expiresDate, code: code)
            DiagnosticLog.log("pair phone: pairing offered", tag: "admin.access", fields: [
                "server_id": serverId, "has_code": String(code != nil)
            ])
        } catch {
            self.error = AdminFailureText.describe(error)
            DiagnosticLog.log("pair phone: offering a pairing failed", tag: "admin.access", level: .warn, fields: [
                "server_id": serverId, "error": AdminFailureText.code(error)
            ])
        }
    }

    /// Watches for the new pairing until the caller's task is cancelled.
    func watch() async {
        for await event in events.events(for: serverId) {
            guard outcome == nil else { return }
            guard event.channel == ServerAdminEvent.clientsChanged || event.channel == ServerAdminEvent.discovery else { continue }
            await relist()
        }
    }

    /// Ends the offer once its link has expired.
    func tick(now: Date) async {
        guard let offer, outcome == nil, now >= offer.expiresAt else { return }
        await finish(.expired)
    }

    func finish(_ ending: Outcome) async {
        guard outcome == nil else { return }
        outcome = ending
        DiagnosticLog.log("pair phone: finished", tag: "admin.access", fields: [
            "server_id": serverId, "outcome": ending.rawValue, "closes_window": String(openedWindow)
        ])
        guard openedWindow else { return }
        do {
            _ = try await client.discoveryClose()
            DiagnosticLog.log("pair phone: discovery window it opened is closed", tag: "admin.access", fields: ["server_id": serverId])
        } catch {
            DiagnosticLog.log("pair phone: closing the discovery window failed", tag: "admin.access", level: .warn, fields: [
                "server_id": serverId, "error": AdminFailureText.code(error)
            ])
        }
    }

    // MARK: - Internals

    private func relist() async {
        guard let known else { return }
        do {
            let clients = try await client.listClients()
            guard let arrived = clients.first(where: { !$0.isRevoked && !known.contains($0.clientId) }) else { return }
            DiagnosticLog.log("pair phone: a new pairing appeared", tag: "admin.access", fields: [
                "server_id": serverId, "kind": arrived.kind.rawValue
            ])
            await finish(.paired)
        } catch {
            DiagnosticLog.log("pair phone: re-listing pairings failed", tag: "admin.access", level: .warn, fields: [
                "server_id": serverId, "error": AdminFailureText.code(error)
            ])
        }
    }

    /// The live code, making the server discoverable first when that is what
    /// it takes. Nil when discovery is sealed or refused: the QR code pairs on
    /// its own, so a missing code is not a failure.
    private func obtainCode() async -> String? {
        do {
            let status = try await client.discoveryStatus()
            switch status.mode {
            case .sealed:
                DiagnosticLog.log("pair phone: discovery is sealed, offering the QR code alone", tag: "admin.access", fields: ["server_id": serverId])
                return nil
            case .window where status.code != nil:
                return status.code
            case .persistent:
                return try await client.discoveryMintCode().code
            case .window, .off:
                let opened = try await client.discoveryOpen(minutes: Self.discoveryMinutes)
                openedWindow = true
                DiagnosticLog.log("pair phone: opened a discovery window for the code", tag: "admin.access", fields: [
                    "server_id": serverId, "minutes": String(Self.discoveryMinutes)
                ])
                return opened.code
            }
        } catch {
            DiagnosticLog.log("pair phone: no code available, offering the QR code alone", tag: "admin.access", level: .warn, fields: [
                "server_id": serverId, "error": AdminFailureText.code(error)
            ])
            return nil
        }
    }
}

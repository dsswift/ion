import Foundation
import Observation

/// Mints a pairing link another device pastes to pair with a server.
@MainActor
@Observable
final class PairingLinkModel {

    private(set) var link: PairingLinkMinted?
    private(set) var minting = false
    private(set) var error: String?

    @ObservationIgnored private let client: ServerAdminClient
    @ObservationIgnored private let serverId: String

    init(client: ServerAdminClient, serverId: String) {
        self.client = client
        self.serverId = serverId
    }

    func mint() async {
        minting = true
        error = nil
        defer { minting = false }
        do {
            link = try await client.createPairingLink(label: "another device")
            DiagnosticLog.log("pairing link: minted", tag: "admin.access", fields: ["server_id": serverId])
        } catch {
            self.error = AdminFailureText.describe(error)
            DiagnosticLog.log("pairing link: mint failed", tag: "admin.access", level: .warn, fields: [
                "server_id": serverId, "error": AdminFailureText.code(error)
            ])
        }
    }
}

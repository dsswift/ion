import Foundation

// MARK: - Access & pairing
//
// Paired devices and pairing links (`server/src/auth/actions.ts`), LAN
// discovery (`server/src/environment/actions.ts`), and how the server reaches
// and names itself to phones (`server/src/protocol/remote-actions.ts`, plus the
// relay keys of its settings document).

extension ServerAdminClient {

    // MARK: Devices

    /// Every pairing the server holds, revoked ones included.
    func listClients() async throws -> [PairedClient] {
        try await call(.authListClients)
    }

    func revokeClient(_ clientId: String) async throws -> RevokeClientResult {
        try await call(.authRevokeClient, fields: ["clientId": .string(clientId)])
    }

    /// Mints a pairing link. Nil `scopes` lets the server grant its default pairing scopes.
    func createPairingLink(label: String, scopes: [StudioScope]? = nil) async throws -> PairingLinkMinted {
        var fields: [String: JSONValue] = ["label": .string(label)]
        if let scopes { fields["scopes"] = .array(scopes.map { .string($0.rawValue) }) }
        return try await call(.authCreatePairingLink, fields: fields)
    }

    // MARK: Discovery

    func discoveryStatus() async throws -> EnvironmentDiscoveryStatus {
        try await call(.environmentDiscoveryStatus)
    }

    /// Makes the server discoverable for `minutes`, then it turns itself off.
    func discoveryOpen(minutes: Int) async throws -> EnvironmentDiscoveryStatus {
        try await call(.environmentDiscoveryOpen, fields: ["minutes": .int(minutes)])
    }

    func discoveryClose() async throws -> EnvironmentDiscoveryStatus {
        try await call(.environmentDiscoveryClose)
    }

    /// A pairing code on an always discoverable server.
    func discoveryMintCode() async throws -> DiscoveryMintedCode {
        try await call(.environmentDiscoveryMintCode)
    }

    // MARK: Name on phones

    /// Nil when the server has never been given a name or icon.
    func remoteDisplay() async throws -> RemoteDisplay? {
        try await call(.remoteGetDisplay)
    }

    /// Sets the name and icon every paired phone shows for the server. The
    /// newest edit wins: an edit older than the stored one is answered with
    /// the stored value.
    func setRemoteDisplay(name: String?, icon: String?, updatedAt: Date) async throws -> RemoteDisplay {
        try await call(.remoteSetDisplay, args: [
            name.map(JSONValue.string) ?? .null,
            icon.map(JSONValue.string) ?? .null,
            .int(Int(updatedAt.timeIntervalSince1970 * 1000)),
        ])
    }

    // MARK: Relay

    /// The relay URL and key in the server's settings document.
    func relaySettings() async throws -> RelaySettings {
        try await call(.settingsLoad)
    }

    /// Writes the relay URL and key. Both are server-wide settings, so the
    /// server takes them only from a connection with admin.
    func saveRelaySettings(_ settings: RelaySettings) async throws {
        try await callVoid(.settingsSave, fields: [
            "relayUrl": .string(settings.relayUrl), "relayApiKey": .string(settings.relayApiKey),
        ])
    }

    /// Asks the relay how it authenticates. Nil when it did not answer.
    func relayAuthConfig(url: String) async throws -> RelayAuthConfig? {
        try await call(.remoteRelayAuthConfig, args: [.string(url)], timeoutSeconds: 15)
    }

    /// Has the server open one socket to the relay with `apiKey`.
    func testRelay(url: String, apiKey: String) async throws -> RelayTestResult {
        try await call(.remoteTestRelay, args: [.string(url), .string(apiKey)], timeoutSeconds: 15)
    }

    /// Starts the server looking for relays on its network. Answers with what
    /// it has found so far; later finds arrive on `ion:remote-relays-changed`.
    func discoverRelays() async throws -> [DiscoveredRelay] {
        try await call(.remoteDiscoverRelays)
    }

    func stopRelayDiscovery() async throws {
        try await callVoid(.remoteStopDiscovery)
    }

    /// Who the server is signed in to Microsoft Entra as, which an Entra relay
    /// admits it by. Nil when signed out.
    func relaySignedInIdentity() async throws -> EntraIdentity? {
        struct Answer: Decodable { let identity: EntraIdentity? }
        let answer: Answer = try await call(.entraIdentity)
        return answer.identity
    }
}

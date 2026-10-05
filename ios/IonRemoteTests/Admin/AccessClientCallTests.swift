import XCTest
@testable import IonRemote

/// Each Access & pairing call names the server's action and sends the
/// arguments its handler reads.
final class AccessClientCallTests: XCTestCase {

    private func make(_ scopes: [String]? = ["admin"]) -> (FakeActionCaller, ServerAdminClient) {
        let caller = FakeActionCaller(scopes: scopes)
        return (caller, ServerAdminClient(serverLabel: "Studio Mac", caller: caller))
    }

    func testDeviceCalls() async throws {
        let (caller, client) = make()
        caller.answer(.authListClients, with: .success(.array([AccessFixtures.client("c1")])))
        caller.answer(.authRevokeClient, with: .success(.object(["revoked": .bool(true), "closed": .int(0)])))
        caller.answer(.authCreatePairingLink, with: .success(AccessFixtures.link()))

        _ = try await client.listClients()
        _ = try await client.revokeClient("c1")
        _ = try await client.createPairingLink(label: "Phone", scopes: [.conversationsRead, .admin])
        _ = try await client.createPairingLink(label: "another device")

        XCTAssertEqual(caller.calls, [
            .init(action: "auth.listClients", args: []),
            .init(action: "auth.revokeClient", args: [.object(["clientId": .string("c1")])]),
            .init(action: "auth.createPairingLink", args: [.object([
                "label": .string("Phone"),
                "scopes": .array([.string("conversations:read"), .string("admin")]),
            ])]),
            .init(action: "auth.createPairingLink", args: [.object(["label": .string("another device")])]),
        ])
    }

    func testDiscoveryCalls() async throws {
        let (caller, client) = make()
        for action in [PhoneAction.environmentDiscoveryStatus, .environmentDiscoveryOpen, .environmentDiscoveryClose] {
            caller.answer(action, with: .success(AccessFixtures.discovery("off")))
        }
        caller.answer(.environmentDiscoveryMintCode, with: .success(.object(["code": .string("WXYZ-2345"), "expiresAt": .int(1)])))

        _ = try await client.discoveryStatus()
        _ = try await client.discoveryOpen(minutes: 60)
        _ = try await client.discoveryClose()
        _ = try await client.discoveryMintCode()

        XCTAssertEqual(caller.calls, [
            .init(action: "environment.discovery.status", args: []),
            .init(action: "environment.discovery.open", args: [.object(["minutes": .int(60)])]),
            .init(action: "environment.discovery.close", args: []),
            .init(action: "environment.discovery.mintCode", args: []),
        ])
    }

    /// The `remote.*` verbs take positional arguments, not one object.
    func testDisplayAndRelayCalls() async throws {
        let (caller, client) = make()
        caller.answer(.remoteSetDisplay, with: .success(.object(["customName": .string("Studio"), "customIcon": .null, "updatedAt": .int(2000)])))
        caller.answer(.remoteTestRelay, with: .success(.object(["success": .bool(true)])))
        caller.answer(.remoteDiscoverRelays, with: .success(.array([])))
        caller.answer(.settingsLoad, with: .success(.object([:])))
        caller.answer(.entraIdentity, with: .success(.object(["identity": .null])))

        _ = try await client.remoteDisplay()
        _ = try await client.setRemoteDisplay(name: "Studio", icon: nil, updatedAt: Date(timeIntervalSince1970: 2))
        _ = try await client.relaySettings()
        try await client.saveRelaySettings(RelaySettings(relayUrl: "wss://relay.example.org", relayApiKey: "k"))
        _ = try await client.relayAuthConfig(url: "wss://relay.example.org")
        _ = try await client.testRelay(url: "wss://relay.example.org", apiKey: "k")
        _ = try await client.discoverRelays()
        try await client.stopRelayDiscovery()
        let identity = try await client.relaySignedInIdentity()

        XCTAssertNil(identity)
        XCTAssertEqual(caller.calls, [
            .init(action: "remote.getDisplay", args: []),
            .init(action: "remote.setDisplay", args: [.string("Studio"), .null, .int(2000)]),
            .init(action: "settings.load", args: []),
            .init(action: "settings.save", args: [.object(["relayUrl": .string("wss://relay.example.org"), "relayApiKey": .string("k")])]),
            .init(action: "remote.relayAuthConfig", args: [.string("wss://relay.example.org")]),
            .init(action: "remote.testRelay", args: [.string("wss://relay.example.org"), .string("k")]),
            .init(action: "remote.discoverRelays", args: []),
            .init(action: "remote.stopDiscovery", args: []),
            .init(action: "entra.identity", args: []),
        ])
    }

    /// Removing a server this phone is not chatting on tells that server to
    /// forget the pairing, through the server's own connection.
    func testRevokingAPairingCallsForgetSelfOnThatServer() async {
        let caller = FakeActionCaller(scopes: ["conversations:read"])

        await SessionViewModel.revokePairing(on: ServerAdminClient(serverLabel: "linux", caller: caller), deviceId: "device-1")

        XCTAssertEqual(caller.calls, [.init(action: "auth.forgetSelf", args: [])])
    }
}

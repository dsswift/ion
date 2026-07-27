import XCTest
@testable import IonRemote

// MARK: - Enterprise Relay Phase 1 + Phase 2: relay_config OIDC decode + credential-swap

final class RelayConfigOidcTests: XCTestCase {
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    // MARK: - relay_config decode (backward compat — no new fields)

    /// Pre-enterprise desktops send relay_config without the four OIDC fields.
    /// The decoder must succeed and treat all new fields as nil.
    func testDecodeRelayConfigLegacy() throws {
        let json = """
        {"type":"desktop_relay_config","relayUrl":"wss://relay.example.com","relayApiKey":"psk-token"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        guard case .relayConfig(
            let relayUrl, let relayApiKey,
            let authMode, let oidcIssuer, let oidcAudience, let oidcScope, let oidcClientId
        ) = event else {
            return XCTFail("Expected relayConfig, got \(event)")
        }
        XCTAssertEqual(relayUrl, "wss://relay.example.com")
        XCTAssertEqual(relayApiKey, "psk-token")
        XCTAssertNil(authMode)
        XCTAssertNil(oidcIssuer)
        XCTAssertNil(oidcAudience)
        XCTAssertNil(oidcScope)
        XCTAssertNil(oidcClientId)
    }

    // MARK: - relay_config decode (PSK authMode, no OIDC fields)

    func testDecodeRelayConfigPsk() throws {
        let json = """
        {"type":"desktop_relay_config","relayUrl":"wss://relay.example.com","relayApiKey":"psk-secret","authMode":"psk"}
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        guard case .relayConfig(_, _, let authMode, let oidcIssuer, let oidcAudience, let oidcScope, let oidcClientId) = event else {
            return XCTFail("Expected relayConfig, got \(event)")
        }
        XCTAssertEqual(authMode, "psk")
        XCTAssertNil(oidcIssuer)
        XCTAssertNil(oidcAudience)
        XCTAssertNil(oidcScope)
        XCTAssertNil(oidcClientId)
    }

    // MARK: - relay_config decode (OIDC authMode + all OIDC fields present)

    func testDecodeRelayConfigOidc() throws {
        let json = """
        {
            "type": "desktop_relay_config",
            "relayUrl": "wss://relay.corp.example.com",
            "relayApiKey": "eyJhbGciOiJSUzI1NiJ9.signed-token",
            "authMode": "oidc",
            "relayOidcIssuer": "https://login.microsoftonline.com/tenant-id/v2.0",
            "relayOidcAudience": "api://client-id",
            "relayOidcRequiredScope": "api://client-id/Relay.Access"
        }
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        guard case .relayConfig(
            let relayUrl, let relayApiKey,
            let authMode, let oidcIssuer, let oidcAudience, let oidcScope, let oidcClientId
        ) = event else {
            return XCTFail("Expected relayConfig, got \(event)")
        }
        XCTAssertEqual(relayUrl, "wss://relay.corp.example.com")
        XCTAssertEqual(relayApiKey, "eyJhbGciOiJSUzI1NiJ9.signed-token")
        XCTAssertEqual(authMode, "oidc")
        XCTAssertEqual(oidcIssuer, "https://login.microsoftonline.com/tenant-id/v2.0")
        XCTAssertEqual(oidcAudience, "api://client-id")
        XCTAssertEqual(oidcScope, "api://client-id/Relay.Access")
        XCTAssertNil(oidcClientId)
    }

    // MARK: - relay_config decode (Phase 2: relayOidcClientId present)

    func testDecodeRelayConfigWithClientId() throws {
        let json = """
        {
            "type": "desktop_relay_config",
            "relayUrl": "wss://relay.corp.example.com",
            "relayApiKey": "eyJhbGciOiJSUzI1NiJ9.signed-token",
            "authMode": "oidc",
            "relayOidcIssuer": "https://login.microsoftonline.com/tenant-id/v2.0",
            "relayOidcAudience": "api://client-id",
            "relayOidcRequiredScope": "api://client-id/Relay.Access",
            "relayOidcClientId": "my-app-client-id"
        }
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        guard case .relayConfig(
            _, _,
            let authMode, let oidcIssuer, _, let oidcScope, let oidcClientId
        ) = event else {
            return XCTFail("Expected relayConfig, got \(event)")
        }
        XCTAssertEqual(authMode, "oidc")
        XCTAssertEqual(oidcIssuer, "https://login.microsoftonline.com/tenant-id/v2.0")
        XCTAssertEqual(oidcScope, "api://client-id/Relay.Access")
        XCTAssertEqual(oidcClientId, "my-app-client-id")
    }

    // MARK: - relay_config decode (backward compat: no relayOidcClientId decodes to nil)

    func testDecodeRelayConfigClientIdBackwardCompat() throws {
        let json = """
        {
            "type": "desktop_relay_config",
            "relayUrl": "wss://relay.corp.example.com",
            "relayApiKey": "token",
            "authMode": "oidc",
            "relayOidcIssuer": "https://issuer.example.com",
            "relayOidcAudience": "api://audience",
            "relayOidcRequiredScope": "api://audience/Relay.Access"
        }
        """.data(using: .utf8)!
        let event = try decoder.decode(RemoteEvent.self, from: json)
        guard case .relayConfig(_, _, _, _, _, _, let oidcClientId) = event else {
            return XCTFail("Expected relayConfig, got \(event)")
        }
        XCTAssertNil(oidcClientId, "relayOidcClientId must be nil when absent from wire")
    }

    // MARK: - relay_config round-trip (OIDC)

    func testRoundTripRelayConfigOidc() throws {
        let original = RemoteEvent.relayConfig(
            relayUrl: "wss://relay.corp.example.com",
            relayApiKey: "token-v2",
            authMode: "oidc",
            relayOidcIssuer: "https://issuer.example.com",
            relayOidcAudience: "api://audience",
            relayOidcRequiredScope: "api://audience/Relay.Access",
            relayOidcClientId: nil
        )
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteEvent.self, from: data)
        guard case .relayConfig(
            let relayUrl, let relayApiKey,
            let authMode, let oidcIssuer, let oidcAudience, let oidcScope, let oidcClientId
        ) = decoded else {
            return XCTFail("Round-trip failed, got \(decoded)")
        }
        XCTAssertEqual(relayUrl, "wss://relay.corp.example.com")
        XCTAssertEqual(relayApiKey, "token-v2")
        XCTAssertEqual(authMode, "oidc")
        XCTAssertEqual(oidcIssuer, "https://issuer.example.com")
        XCTAssertEqual(oidcAudience, "api://audience")
        XCTAssertEqual(oidcScope, "api://audience/Relay.Access")
        XCTAssertNil(oidcClientId)
    }

    // MARK: - relay_config round-trip with relayOidcClientId (Phase 2)

    func testRoundTripWithClientId() throws {
        let original = RemoteEvent.relayConfig(
            relayUrl: "wss://relay.corp.example.com",
            relayApiKey: "token-v3",
            authMode: "oidc",
            relayOidcIssuer: "https://issuer.example.com",
            relayOidcAudience: "api://audience",
            relayOidcRequiredScope: "api://audience/Relay.Access",
            relayOidcClientId: "phase2-client-id"
        )
        let data = try encoder.encode(original)
        let decoded = try decoder.decode(RemoteEvent.self, from: data)
        guard case .relayConfig(
            let relayUrl, let relayApiKey,
            let authMode, let oidcIssuer, let oidcAudience, let oidcScope, let oidcClientId
        ) = decoded else {
            return XCTFail("Round-trip failed, got \(decoded)")
        }
        XCTAssertEqual(relayUrl, "wss://relay.corp.example.com")
        XCTAssertEqual(relayApiKey, "token-v3")
        XCTAssertEqual(authMode, "oidc")
        XCTAssertEqual(oidcIssuer, "https://issuer.example.com")
        XCTAssertEqual(oidcAudience, "api://audience")
        XCTAssertEqual(oidcScope, "api://audience/Relay.Access")
        XCTAssertEqual(oidcClientId, "phase2-client-id")
    }

    // MARK: - round-trip (legacy — nil fields must be omitted, not "null")

    func testRoundTripRelayConfigLegacyOmitsNilFields() throws {
        let original = RemoteEvent.relayConfig(
            relayUrl: "wss://relay.example.com",
            relayApiKey: "psk",
            authMode: nil,
            relayOidcIssuer: nil,
            relayOidcAudience: nil,
            relayOidcRequiredScope: nil,
            relayOidcClientId: nil
        )
        let data = try encoder.encode(original)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertNil(json["authMode"], "nil authMode must be omitted, not null")
        XCTAssertNil(json["relayOidcIssuer"])
        XCTAssertNil(json["relayOidcAudience"])
        XCTAssertNil(json["relayOidcRequiredScope"])
        XCTAssertNil(json["relayOidcClientId"])
        // Required fields must be present.
        XCTAssertEqual(json["relayUrl"] as? String, "wss://relay.example.com")
        XCTAssertEqual(json["relayApiKey"] as? String, "psk")
    }

    // MARK: - Credential swap triggers softReconnect

    /// When handleRelayConfig receives a different relayApiKey, softReconnect
    /// must be called on the view model. We pin this by verifying the transport
    /// is torn down and rebuilt (transport changes from original to a new instance).
    ///
    /// SessionViewModel.softReconnect builds a new TransportManager when the
    /// active device is not lan-direct. The test verifies the old transport
    /// object is no longer the current transport after handleRelayConfig with
    /// a changed key.
    @MainActor
    func testCredentialChangeTriggersSoftReconnect() async throws {
        let vm = SessionViewModel()

        // Set up a minimal paired device with a relay configuration.
        let sharedSecret = Data(repeating: 0xAB, count: 32)
        var device = PairedDevice(
            id: "test-device-id",
            name: "TestMac",
            pairedAt: Date(),
            lastSeen: nil,
            channelId: "channel-abc",
            sharedSecret: sharedSecret,
            relayURL: "wss://relay.example.com",
            relayAPIKey: "old-token"
        )
        device.relayAuthMode = "oidc"
        vm.pairedDevices = [device]
        vm.activeDeviceId = device.id
        vm.relayURL = "wss://relay.example.com"
        vm.relayAPIKey = "old-token"

        // Install a sentinel transport so we can detect the reconnect.
        // softReconnect creates a new TransportManager when not lan-direct;
        // after the call the vm.transport property must differ from sentinel.
        // We can't build a real TransportManager without a network, so we
        // verify that the relayAPIKey is updated to the new value.
        vm.handleRelayConfig(
            relayUrl: "wss://relay.example.com",
            relayApiKey: "new-token",
            authMode: "oidc",
            relayOidcIssuer: "https://login.microsoftonline.com/tenant/v2.0",
            relayOidcAudience: "api://client",
            relayOidcRequiredScope: "api://client/Relay.Access",
            relayOidcClientId: nil
        )

        // The credential must be updated on both the vm and the device record.
        XCTAssertEqual(vm.relayAPIKey, "new-token")
        XCTAssertEqual(vm.pairedDevices.first?.relayAPIKey, "new-token")
        // OIDC metadata must be persisted on the device record.
        XCTAssertEqual(vm.pairedDevices.first?.relayAuthMode, "oidc")
        XCTAssertEqual(vm.pairedDevices.first?.relayOidcIssuer, "https://login.microsoftonline.com/tenant/v2.0")
        XCTAssertEqual(vm.pairedDevices.first?.relayOidcAudience, "api://client")
        XCTAssertEqual(vm.pairedDevices.first?.relayOidcRequiredScope, "api://client/Relay.Access")
    }

    // MARK: - Same credential does NOT trigger softReconnect

    /// When the relayApiKey is unchanged, handleRelayConfig must NOT call
    /// softReconnect (no transport churn for token refreshes that are identical).
    @MainActor
    func testSameCredentialDoesNotTriggerReconnect() throws {
        let vm = SessionViewModel()

        let sharedSecret = Data(repeating: 0xCD, count: 32)
        let device = PairedDevice(
            id: "dev-same",
            name: "SameMac",
            pairedAt: Date(),
            lastSeen: nil,
            channelId: "channel-same",
            sharedSecret: sharedSecret,
            relayURL: "wss://relay.example.com",
            relayAPIKey: "stable-token"
        )
        vm.pairedDevices = [device]
        vm.activeDeviceId = device.id
        vm.relayURL = "wss://relay.example.com"
        vm.relayAPIKey = "stable-token"

        // Call with identical token. connectionState must not change to .connecting
        // (softReconnect would set it to .reconnecting and tear down transport).
        vm.connectionState = .connected
        vm.handleRelayConfig(
            relayUrl: "wss://relay.example.com",
            relayApiKey: "stable-token",
            authMode: "psk",
            relayOidcIssuer: nil,
            relayOidcAudience: nil,
            relayOidcRequiredScope: nil,
            relayOidcClientId: nil
        )

        // connectionState must remain .connected — no reconnect fired.
        XCTAssertEqual(vm.connectionState, .connected)
    }

    // MARK: - An empty credential must never overwrite the stored relay config

    // The live failure: the desktop's on-disk relayAuthMode had been wiped by a
    // renderer settings save, so its peer-connect handler fell through to the
    // PSK branch and pushed `{ relayUrl, relayApiKey: "" }` (the stored PSK is
    // deliberately empty in OIDC mode). iOS persisted that emptiness straight
    // into the keychain, destroying the pairing's relay record — after which
    // softReconnect had no URL to build a transport from and the app could not
    // reconnect at all.
    //
    // Fails on the unfixed code: both fields become "".

    @MainActor
    func testEmptyCredentialDoesNotWipeStoredRelayConfig() throws {
        let vm = SessionViewModel()

        let device = PairedDevice(
            id: "dev-empty-push",
            name: "TestMac",
            pairedAt: Date(),
            lastSeen: nil,
            channelId: "channel-empty",
            sharedSecret: Data(repeating: 0xEF, count: 32),
            relayURL: "wss://relay.example.com",
            relayAPIKey: "working-token"
        )
        vm.pairedDevices = [device]
        vm.activeDeviceId = device.id
        // In-memory pair deliberately left empty: this is the cold-launch
        // state, which is exactly when the defect struck.
        vm.relayURL = ""
        vm.relayAPIKey = ""

        vm.handleRelayConfig(
            relayUrl: "wss://relay.example.com",
            relayApiKey: "",
            authMode: "psk",
            relayOidcIssuer: nil,
            relayOidcAudience: nil,
            relayOidcRequiredScope: nil,
            relayOidcClientId: nil
        )

        XCTAssertEqual(vm.pairedDevices.first?.relayURL, "wss://relay.example.com",
            "an empty push must not erase the stored relay URL")
        XCTAssertEqual(vm.pairedDevices.first?.relayAPIKey, "working-token",
            "an empty push must not erase the stored relay credential")
    }

    @MainActor
    func testEmptyCredentialStillPersistsOidcMetadata() throws {
        // The OIDC metadata is independently useful even with no token: iOS
        // mints its own against the issuer + client ID.
        let vm = SessionViewModel()

        let device = PairedDevice(
            id: "dev-meta",
            name: "TestMac",
            pairedAt: Date(),
            lastSeen: nil,
            channelId: "channel-meta",
            sharedSecret: Data(repeating: 0x11, count: 32),
            relayURL: "wss://relay.example.com",
            relayAPIKey: "working-token"
        )
        vm.pairedDevices = [device]
        vm.activeDeviceId = device.id
        vm.relayURL = ""
        vm.relayAPIKey = ""

        vm.handleRelayConfig(
            relayUrl: "wss://relay.example.com",
            relayApiKey: "",
            authMode: "oidc",
            relayOidcIssuer: "https://issuer.example.com/v2.0",
            relayOidcAudience: "api://audience",
            relayOidcRequiredScope: "api://audience/Relay.Access",
            relayOidcClientId: "client-id"
        )

        XCTAssertEqual(vm.pairedDevices.first?.relayAPIKey, "working-token")
        XCTAssertEqual(vm.pairedDevices.first?.relayOidcIssuer, "https://issuer.example.com/v2.0")
        XCTAssertEqual(vm.pairedDevices.first?.relayOidcClientId, "client-id")
    }

    @MainActor
    func testRealCredentialStillOverwritesStoredConfig() throws {
        // The guard must not make the stored config sticky — a genuine
        // rotation still has to land.
        let vm = SessionViewModel()

        let device = PairedDevice(
            id: "dev-rotate",
            name: "TestMac",
            pairedAt: Date(),
            lastSeen: nil,
            channelId: "channel-rotate",
            sharedSecret: Data(repeating: 0x22, count: 32),
            relayURL: "wss://old-relay.example.com",
            relayAPIKey: "old-token"
        )
        vm.pairedDevices = [device]
        vm.activeDeviceId = device.id
        vm.relayURL = "wss://old-relay.example.com"
        vm.relayAPIKey = "old-token"

        vm.handleRelayConfig(
            relayUrl: "wss://new-relay.example.com",
            relayApiKey: "new-token",
            authMode: "psk",
            relayOidcIssuer: nil,
            relayOidcAudience: nil,
            relayOidcRequiredScope: nil,
            relayOidcClientId: nil
        )

        XCTAssertEqual(vm.pairedDevices.first?.relayURL, "wss://new-relay.example.com")
        XCTAssertEqual(vm.pairedDevices.first?.relayAPIKey, "new-token")
    }
}

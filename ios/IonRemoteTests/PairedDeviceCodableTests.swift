import XCTest
@testable import IonRemote

/// `PairedDevice` persistence across the account-fields addition.
///
/// Paired devices live in the Keychain as a JSON blob written by an earlier
/// build. If adding the OIDC account fields broke that decode, every pairing on
/// the device would vanish on upgrade — the user would be dropped back to the
/// pairing screen with no way to recover except re-pairing every desktop.
final class PairedDeviceCodableTests: XCTestCase {

    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    // MARK: - Backward compatibility

    /// A blob written before the account fields existed must still decode, with
    /// the new fields nil.
    func testLegacyBlobWithoutAccountFieldsDecodes() throws {
        let json = """
        [{
            "id": "device-legacy",
            "name": "OldMac",
            "pairedAt": 750000000,
            "channelId": "channel-legacy",
            "sharedSecret": "\(Data(repeating: 0x2A, count: 32).base64EncodedString())",
            "relayURL": "wss://relay.example.com",
            "relayAPIKey": "psk-token",
            "relayAuthMode": "oidc",
            "relayOidcIssuer": "https://login.example.com/tenant/v2.0",
            "relayOidcClientId": "client-id",
            "relayOidcRequiredScope": "api://audience/Relay.Access"
        }]
        """.data(using: .utf8)!

        let devices = try decoder.decode([PairedDevice].self, from: json)

        XCTAssertEqual(devices.count, 1)
        let device = try XCTUnwrap(devices.first)
        XCTAssertEqual(device.id, "device-legacy")
        XCTAssertEqual(device.relayOidcIssuer, "https://login.example.com/tenant/v2.0")
        XCTAssertNil(device.relayOidcAccountUsername)
        XCTAssertNil(device.relayOidcAccountName)
        XCTAssertNil(device.relayOidcSubject)
        XCTAssertNil(device.relayOidcTenantId)
        XCTAssertNil(device.relayOidcSignedInAt)
    }

    /// A pre-enterprise blob (no OIDC keys at all) still decodes.
    func testPreEnterpriseBlobDecodes() throws {
        let json = """
        [{
            "id": "device-psk",
            "name": "PskMac",
            "pairedAt": 750000000,
            "channelId": "channel-psk",
            "sharedSecret": "\(Data(repeating: 0x07, count: 32).base64EncodedString())",
            "relayURL": "wss://relay.example.com",
            "relayAPIKey": "psk-token"
        }]
        """.data(using: .utf8)!

        let devices = try decoder.decode([PairedDevice].self, from: json)
        let device = try XCTUnwrap(devices.first)
        XCTAssertNil(device.relayAuthMode)
        XCTAssertNil(device.relayOidcAccountUsername)
        XCTAssertFalse(device.usesOIDC)
    }

    // MARK: - Round trip

    func testAccountFieldsSurviveRoundTrip() throws {
        var device = PairedDevice(
            id: "device-work",
            name: "WorkMac",
            pairedAt: Date(timeIntervalSince1970: 750_000_000),
            lastSeen: nil,
            channelId: "channel-work",
            sharedSecret: Data(repeating: 0x5A, count: 32),
            relayURL: "wss://relay.corp.example.com",
            relayAPIKey: ""
        )
        device.relayAuthMode = "oidc"
        device.relayOidcIssuer = "https://login.microsoftonline.com/work-tenant/v2.0"
        device.relayOidcClientId = "work-client"
        device.relayOidcRequiredScope = "api://work/Relay.Access"
        device.relayOidcAccountUsername = "user@example.com"
        device.relayOidcAccountName = "Example User"
        device.relayOidcSubject = "work-subject"
        device.relayOidcTenantId = "work-tenant"
        device.relayOidcSignedInAt = Date(timeIntervalSince1970: 760_000_000)

        let restored = try decoder.decode([PairedDevice].self, from: encoder.encode([device]))
        let out = try XCTUnwrap(restored.first)

        XCTAssertEqual(out.relayOidcAccountUsername, "user@example.com")
        XCTAssertEqual(out.relayOidcAccountName, "Example User")
        XCTAssertEqual(out.relayOidcSubject, "work-subject")
        XCTAssertEqual(out.relayOidcTenantId, "work-tenant")
        XCTAssertEqual(out.relayOidcSignedInAt, Date(timeIntervalSince1970: 760_000_000))
    }

    // MARK: - Display helpers

    func testUsesOIDCRequiresModeIssuerAndClientId() {
        var device = PairedDevice(
            id: "d", name: "n", pairedAt: Date(), lastSeen: nil,
            channelId: "c", sharedSecret: Data(repeating: 1, count: 32),
            relayURL: "wss://relay.example.com", relayAPIKey: ""
        )
        XCTAssertFalse(device.usesOIDC, "no auth mode")

        device.relayAuthMode = "oidc"
        XCTAssertFalse(device.usesOIDC, "oidc mode but no client ID or issuer")

        device.relayOidcClientId = "client"
        XCTAssertFalse(device.usesOIDC, "still no issuer")

        device.relayOidcIssuer = "https://login.example.com/tenant/v2.0"
        XCTAssertFalse(device.usesOIDC, "still no scope")

        device.relayOidcRequiredScope = "api://client/Relay.Access"
        XCTAssertTrue(device.usesOIDC)
    }

    func testAccountLabelPrefersUsername() {
        var device = PairedDevice(
            id: "d", name: "n", pairedAt: Date(), lastSeen: nil,
            channelId: "c", sharedSecret: Data(repeating: 1, count: 32),
            relayURL: "", relayAPIKey: ""
        )
        XCTAssertNil(device.oidcAccountLabel)

        device.relayOidcAccountName = "Example User"
        XCTAssertEqual(device.oidcAccountLabel, "Example User")

        device.relayOidcAccountUsername = "user@example.com"
        XCTAssertEqual(device.oidcAccountLabel, "user@example.com")
    }

    // MARK: - desktopId backward compat + round trip

    func testPreDesktopIdBlobDecodes() throws {
        let json = """
        [{
            "id": "device-old",
            "name": "OldMac",
            "pairedAt": 750000000,
            "channelId": "channel-old",
            "sharedSecret": "\(Data(repeating: 0x11, count: 32).base64EncodedString())",
            "relayURL": "wss://relay.example.com",
            "relayAPIKey": "psk"
        }]
        """.data(using: .utf8)!

        let devices = try decoder.decode([PairedDevice].self, from: json)
        let device = try XCTUnwrap(devices.first)
        XCTAssertNil(device.desktopId)
    }

    func testDesktopIdSurvivesRoundTrip() throws {
        var device = PairedDevice(
            id: "device-did", name: "DesktopIdMac", pairedAt: Date(),
            lastSeen: nil, channelId: "channel-did",
            sharedSecret: Data(repeating: 0x22, count: 32),
            relayURL: "wss://relay.example.com", relayAPIKey: "key"
        )
        device.desktopId = "stable-uuid-1234"

        let restored = try decoder.decode(
            [PairedDevice].self, from: encoder.encode([device])
        )
        let out = try XCTUnwrap(restored.first)
        XCTAssertEqual(out.desktopId, "stable-uuid-1234")
    }

    func testDesktopIdNilWhenNotSet() throws {
        let device = PairedDevice(
            id: "d", name: "n", pairedAt: Date(), lastSeen: nil,
            channelId: "c", sharedSecret: Data(repeating: 1, count: 32),
            relayURL: "", relayAPIKey: ""
        )
        let restored = try decoder.decode(
            [PairedDevice].self, from: encoder.encode([device])
        )
        XCTAssertNil(try XCTUnwrap(restored.first).desktopId)
    }

    func testIssuerHostExtraction() {
        var device = PairedDevice(
            id: "d", name: "n", pairedAt: Date(), lastSeen: nil,
            channelId: "c", sharedSecret: Data(repeating: 1, count: 32),
            relayURL: "", relayAPIKey: ""
        )
        XCTAssertNil(device.oidcIssuerHost)

        device.relayOidcIssuer = "https://login.microsoftonline.com/tenant-id/v2.0"
        XCTAssertEqual(device.oidcIssuerHost, "login.microsoftonline.com")
    }
}

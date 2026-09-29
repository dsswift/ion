import XCTest
@testable import IonRemote

/// The Access & pairing result types read the server's real shapes.
final class AccessModelDecodingTests: XCTestCase {

    func testAPairedClientDecodesWithItsMarks() throws {
        let client = try AccessFixtures.client("c1", scopes: ["admin", "conversations:read"]).decoded(as: PairedClient.self)
        XCTAssertEqual(client.clientId, "c1")
        XCTAssertEqual(client.kind, .mobile)
        XCTAssertTrue(client.isAdmin)
        XCTAssertFalse(client.isRevoked)
        XCTAssertEqual(client.displayName, "Pixel desk")
        XCTAssertEqual(client.kindName, "phone")
        XCTAssertEqual(client.lastSeenDate, Date(timeIntervalSince1970: 1_700_000_500))
    }

    func testAPairedClientSaysWhetherItIsConnectedNow() throws {
        XCTAssertTrue(try AccessFixtures.client("c1", connected: true).decoded(as: PairedClient.self).isConnected)
        XCTAssertFalse(try AccessFixtures.client("c1", connected: false).decoded(as: PairedClient.self).isConnected)
        // A server that predates the field.
        XCTAssertFalse(try AccessFixtures.client("c1").decoded(as: PairedClient.self).isConnected)
    }

    func testAPairingWithoutALabelReadsAsUnnamed() throws {
        let client = try AccessFixtures.client("c2", label: nil, kind: "desktop", revokedAt: 1_700_000_600_000).decoded(as: PairedClient.self)
        XCTAssertEqual(client.displayName, "Unnamed device")
        XCTAssertEqual(client.kind, .desktop)
        XCTAssertTrue(client.isRevoked)
    }

    func testDiscoveryStatusDecodesEveryMode() throws {
        for mode in ["sealed", "off", "window", "persistent"] {
            let status = try AccessFixtures.discovery(mode).decoded(as: EnvironmentDiscoveryStatus.self)
            XCTAssertEqual(status.mode.rawValue, mode)
        }
        let window = try AccessFixtures.discovery("window", until: 1_700_000_900_000, code: "ABCD-2345").decoded(as: EnvironmentDiscoveryStatus.self)
        XCTAssertEqual(window.code, "ABCD-2345")
        XCTAssertEqual(window.untilDate, Date(timeIntervalSince1970: 1_700_000_900))
    }

    func testRemoteDisplayDecodesAndANullMeansNeverSet() throws {
        let display = try JSONValue.object(["customName": .string("Studio"), "customIcon": .null, "updatedAt": .int(5)]).decoded(as: RemoteDisplay?.self)
        XCTAssertEqual(display, RemoteDisplay(customName: "Studio", customIcon: nil, updatedAt: 5))
        XCTAssertNil(try JSONValue.null.decoded(as: RemoteDisplay?.self))
    }

    func testRelaySettingsReadFromTheWholeSettingsDocument() throws {
        let document: JSONValue = .object(["relayUrl": .string("wss://relay.example.org"), "relayApiKey": .string("k"), "theme": .string("dark")])
        XCTAssertEqual(try document.decoded(as: RelaySettings.self), RelaySettings(relayUrl: "wss://relay.example.org", relayApiKey: "k"))
        let bare = try JSONValue.object(["theme": .string("dark")]).decoded(as: RelaySettings.self)
        XCTAssertFalse(bare.isConfigured)
    }

    func testRelayAuthConfigAndDiscoveredRelayDecode() throws {
        XCTAssertEqual(try AccessFixtures.entraRelay.decoded(as: RelayAuthConfig.self).modeName, "Microsoft Entra sign-in")
        XCTAssertEqual(try AccessFixtures.pskRelay.decoded(as: RelayAuthConfig.self).modeName, "Shared key")
        let relay = try JSONValue.object([
            "id": .string("r1"), "name": .string("Office relay"), "host": .string("relay.local"), "port": .int(8080),
            "addresses": .array([.string("fe80::1"), .string("192.0.2.5")]),
        ]).decoded(as: DiscoveredRelay.self)
        XCTAssertEqual(relay.url, "ws://192.0.2.5:8080")
    }

    func testPairingLinkRevokeAndTestResultsDecode() throws {
        XCTAssertEqual(try AccessFixtures.link().decoded(as: PairingLinkMinted.self).code, "ABCD2345")
        XCTAssertEqual(try JSONValue.object(["revoked": .bool(true), "closed": .int(1)]).decoded(as: RevokeClientResult.self), RevokeClientResult(revoked: true, closed: 1))
        XCTAssertEqual(try JSONValue.object(["success": .bool(false), "error": .string("bad key")]).decoded(as: RelayTestResult.self).error, "bad key")
        XCTAssertEqual(try JSONValue.object(["code": .string("WXYZ-2345"), "expiresAt": .int(1)]).decoded(as: DiscoveryMintedCode.self).code, "WXYZ-2345")
    }

    func testTheQRCodeOfAPairingLinkIsDrawn() throws {
        let image = try XCTUnwrap(QRCodeImage.make(from: "ion-studio://pair?code=ABCD2345&host=192.0.2.4"))
        XCTAssertGreaterThan(image.size.width, 100)
        XCTAssertEqual(image.size.width, image.size.height)
    }

    func testTheCountdownReadsMinutesAndSeconds() {
        let now = Date(timeIntervalSince1970: 1000)
        XCTAssertEqual(AccessCountdown.remaining(until: now.addingTimeInterval(125), now: now), "2:05")
        XCTAssertEqual(AccessCountdown.remaining(until: now.addingTimeInterval(-5), now: now), "0:00")
    }
}

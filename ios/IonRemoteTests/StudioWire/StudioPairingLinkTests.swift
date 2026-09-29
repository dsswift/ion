import XCTest
@testable import IonRemote

/// `ion-studio://pair?…` links, in the form the server writes them
/// (`formatPairingLink` in `server/src/auth/pairing-links.ts`).
final class StudioPairingLinkTests: XCTestCase {

    func testAValidLinkYieldsItsCodeServerAndLabel() throws {
        let link = try StudioPairingLink.parse("ion-studio://pair?code=FSSE2S5J&url=http%3A%2F%2Fstudio-host.local%3A7331&env=Build+box")
        XCTAssertEqual(link.code, "FSSE2S5J")
        XCTAssertEqual(link.serverURL, URL(string: "http://studio-host.local:7331"))
        XCTAssertEqual(link.label, "Build box")
        XCTAssertNil(link.relay)
    }

    func testALiteralPlusInAValueSurvives() throws {
        let link = try StudioPairingLink.parse("ion-studio://pair?code=AB%2BCD&url=http%3A%2F%2F10.0.0.2%3A7331&env=a%2Bb")
        XCTAssertEqual(link.code, "AB+CD")
        XCTAssertEqual(link.label, "a+b")
    }

    func testALinkMayAlsoNameARelayChannel() throws {
        let link = try StudioPairingLink.parse(
            "ion-studio://pair?code=FSSE2S5J&url=http%3A%2F%2F10.0.0.2%3A7331&env=host&relay=wss%3A%2F%2Frelay.example.org&channel=abc123&relayKey=psk-1"
        )
        XCTAssertEqual(link.relay, .init(relayURL: "wss://relay.example.org", channelId: "abc123", key: "psk-1"))
        XCTAssertNotNil(link.serverURL)
    }

    func testARelayOnlyLinkParsesWithNoServerAddress() throws {
        let link = try StudioPairingLink.parse("ion-studio://pair?code=FSSE2S5J&relay=wss%3A%2F%2Frelay.example.org&channel=abc123")
        XCTAssertNil(link.serverURL)
        XCTAssertEqual(link.relay, .init(relayURL: "wss://relay.example.org", channelId: "abc123", key: nil))
    }

    func testSurroundingWhitespaceFromAPasteIsIgnored() throws {
        let link = try StudioPairingLink.parse("  ion-studio://pair?code=FSSE2S5J&url=http%3A%2F%2F10.0.0.2%3A7331&env=host\n")
        XCTAssertEqual(link.code, "FSSE2S5J")
    }

    func testAMissingCodeIsRefused() {
        XCTAssertThrowsError(try StudioPairingLink.parse("ion-studio://pair?url=http%3A%2F%2F10.0.0.2%3A7331&env=host")) {
            XCTAssertEqual($0 as? StudioPairingLink.ParseError, .missingCode)
        }
        XCTAssertThrowsError(try StudioPairingLink.parse("ion-studio://pair?code=&url=http%3A%2F%2F10.0.0.2%3A7331")) {
            XCTAssertEqual($0 as? StudioPairingLink.ParseError, .missingCode)
        }
    }

    func testAnotherSchemeIsRefused() {
        XCTAssertThrowsError(try StudioPairingLink.parse("https://pair?code=FSSE2S5J&url=http%3A%2F%2F10.0.0.2%3A7331")) {
            XCTAssertEqual($0 as? StudioPairingLink.ParseError, .wrongScheme("https"))
        }
    }

    func testAnIonStudioLinkThatIsNotAPairingLinkIsRefused() {
        XCTAssertThrowsError(try StudioPairingLink.parse("ion-studio://open?code=FSSE2S5J")) {
            XCTAssertEqual($0 as? StudioPairingLink.ParseError, .notAPairingLink)
        }
    }

    func testTextThatIsNotALinkIsRefused() {
        XCTAssertThrowsError(try StudioPairingLink.parse("FSSE-2S5J")) {
            XCTAssertEqual($0 as? StudioPairingLink.ParseError, .notALink)
        }
    }

    func testALinkWithNeitherAServerNorARelayIsRefused() {
        XCTAssertThrowsError(try StudioPairingLink.parse("ion-studio://pair?code=FSSE2S5J&url=ftp%3A%2F%2F10.0.0.2")) {
            XCTAssertEqual($0 as? StudioPairingLink.ParseError, .noDestination)
        }
    }

    func testLooksLikeLinkTellsALinkFromARelayPayload() {
        XCTAssertTrue(StudioPairingLink.looksLikeLink(" ION-STUDIO://pair?code=x"))
        XCTAssertFalse(StudioPairingLink.looksLikeLink(#"{"relayUrls":[],"channelId":"x"}"#))
    }
}

import XCTest
@testable import IonRemote

/// Pins that PeerStatusPoller logs (via DiagnosticLog) instead of returning a
/// bare nil on the error paths. Before the observability pass every failure
/// (invalid URL, non-200, decode error, thrown error) collapsed to an
/// indistinguishable `return nil`, so an operator could not tell "peer offline"
/// from "poll broke". The invalid-URL path is exercised here because it needs
/// no network and is fully deterministic.
final class PeerStatusPollerLoggingTests: XCTestCase {

    func testInvalidRelayURLLogsAndReturnsNil() async {
        DiagnosticLog.clear()

        // Empty relay URL -> the guard fires before any network call.
        let result = await PeerStatusPoller.checkDesktopOnline(
            relayURL: "",
            bearer: "key",
            channelId: "chan-abc"
        )
        XCTAssertNil(result, "empty relay URL must return nil")

        let logged = DiagnosticLog.entries().contains { entry in
            entry.tag == "transport.peerstatus" && entry.level == .warn
        }
        XCTAssertTrue(logged, "invalid relay URL must produce a transport.peerstatus warning, not a silent nil")
    }

    /// An OIDC pairing with no silently-obtainable token must be reported as
    /// unknown, not polled with whatever stale key happens to be stored.
    ///
    /// Before this, every pairing was polled with `device.relayAPIKey`; in OIDC
    /// mode that holds a stale desktop-minted bootstrap token (often empty), so
    /// the relay answered 401/403 and the desktop was rendered offline.
    func testNilBearerSkipsRequestAndWarns() async {
        DiagnosticLog.clear()

        let result = await PeerStatusPoller.checkDesktopOnline(
            relayURL: "wss://relay.example.com",
            bearer: nil,
            channelId: "chan-oidc"
        )
        XCTAssertNil(result, "no credential means unknown status, never a guessed answer")

        let logged = DiagnosticLog.entries().contains { entry in
            entry.tag == "transport.peerstatus" && entry.level == .warn
        }
        XCTAssertTrue(logged, "skipping the poll for lack of a credential must be observable")
    }

    func testEmptyBearerIsTreatedAsMissing() async {
        DiagnosticLog.clear()

        let result = await PeerStatusPoller.checkDesktopOnline(
            relayURL: "wss://relay.example.com",
            bearer: "",
            channelId: "chan-empty"
        )
        XCTAssertNil(result)

        let logged = DiagnosticLog.entries().contains { entry in
            entry.tag == "transport.peerstatus" && entry.level == .warn
        }
        XCTAssertTrue(logged)
    }
}

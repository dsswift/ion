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
            apiKey: "key",
            channelId: "chan-abc"
        )
        XCTAssertNil(result, "empty relay URL must return nil")

        let logged = DiagnosticLog.entries().contains { entry in
            entry.tag == "transport.peerstatus" && entry.level == .warn
        }
        XCTAssertTrue(logged, "invalid relay URL must produce a transport.peerstatus warning, not a silent nil")
    }
}

import XCTest
import CryptoKit
@testable import IonRemote

/// Regression tests for the "reconnecting forever against a dead identity"
/// incident: the phone held a pairing the desktop no longer knew, the desktop
/// answered every LAN auth with close 4003 "unknown device" (a DEFINITIVE
/// rejection), and the Bonjour auto-reconnect loop only checked for
/// `.success` — so it nil'd the host and retried the same dead identity every
/// ~500ms. The user was never shown the pairing screen, and the hammering
/// re-tripped the desktop's auth cooldown (close 1008) on every subsequent
/// attempt.
///
/// The loop itself needs real Bonjour + sockets, so these tests drive its
/// extracted policy seam (`applyLANAuthOutcome` / `shouldAttemptLANConnect`
/// in TransportManager+BonjourReconnect.swift) — the exact functions the loop
/// calls around every connect attempt.
final class BonjourLANAuthRejectionTests: XCTestCase {

    private func makeLANOnlyTransport() -> TransportManager {
        TransportManager(sharedKey: SymmetricKey(size: .bits256), deviceId: "device-under-test")
    }

    // MARK: - Definitive rejection (Fix 1)

    func testRejectedOutcomeYieldsLanAuthRejectedEvent() async {
        let tm = makeLANOnlyTransport()
        var iterator = tm.events.makeAsyncIterator()

        tm.applyLANAuthOutcome(.rejected, host: "192.168.1.10", port: 8422)

        // The AsyncStream buffers, so the yield above is already queued.
        let event = await iterator.next()
        guard case .lanAuthRejected = event else {
            return XCTFail("A definitive rejection must yield .lanAuthRejected, got \(String(describing: event))")
        }
    }

    func testRejectedOutcomeStopsAllFurtherLANAttempts() {
        let tm = makeLANOnlyTransport()

        tm.applyLANAuthOutcome(.rejected, host: "192.168.1.10", port: 8422)

        XCTAssertTrue(tm.lanAuthRejectedDefinitively)
        XCTAssertNil(tm.currentLANHost, "Rejected attempt must clear the current host")
        XCTAssertFalse(tm.shouldAttemptLANConnect(),
            "On the unfixed code the loop retried the dead identity on the next 500ms tick")
        XCTAssertFalse(tm.shouldAttemptLANConnect(now: .distantFuture),
            "A definitive rejection is permanent for this transport — no amount of waiting revives a dead identity")
    }

    // MARK: - Transient backoff (Fix 2)

    func testTransientOutcomeOpensEscalatingBackoffWindow() {
        let tm = makeLANOnlyTransport()
        XCTAssertTrue(tm.shouldAttemptLANConnect(), "Fresh transport must be allowed to attempt")

        let before = Date()
        tm.applyLANAuthOutcome(.transient, host: "192.168.1.10", port: 8422)

        XCTAssertFalse(tm.lanAuthRejectedDefinitively,
            "A transient failure carries no verdict and must never latch the rejected flag")
        XCTAssertFalse(tm.shouldAttemptLANConnect(),
            "On the unfixed code the loop retried on the next 500ms tick with no backoff")
        // First failure = 1s window; it must reopen once the window elapses.
        XCTAssertTrue(tm.shouldAttemptLANConnect(now: before.addingTimeInterval(1.5)),
            "Transient failures keep retrying after the backoff window — only .rejected stops the loop")

        // Second failure escalates to 2s: still closed at +1.5s from now.
        let secondBefore = Date()
        tm.applyLANAuthOutcome(.transient, host: "192.168.1.10", port: 8422)
        XCTAssertEqual(tm.lanReconnectBackoff.consecutiveFailures, 2)
        XCTAssertFalse(tm.shouldAttemptLANConnect(now: secondBefore.addingTimeInterval(1.5)),
            "Second consecutive failure must wait the escalated 2s, not the initial 1s")
        XCTAssertTrue(tm.shouldAttemptLANConnect(now: secondBefore.addingTimeInterval(2.5)))
    }

    func testSuccessResetsBackoffLadder() {
        let tm = makeLANOnlyTransport()
        tm.applyLANAuthOutcome(.transient, host: "192.168.1.10", port: 8422)
        tm.applyLANAuthOutcome(.transient, host: "192.168.1.10", port: 8422)
        tm.applyLANAuthOutcome(.transient, host: "192.168.1.10", port: 8422)
        XCTAssertEqual(tm.lanReconnectBackoff.consecutiveFailures, 3)

        tm.applyLANAuthOutcome(.success, host: "192.168.1.10", port: 8422)

        XCTAssertEqual(tm.lanReconnectBackoff.consecutiveFailures, 0)
        XCTAssertTrue(tm.shouldAttemptLANConnect(),
            "A successful auth must clear any open backoff window immediately")
    }

    func testTransientOutcomeYieldsNoEventAndRejectionYieldsExactlyOne() async {
        let tm = makeLANOnlyTransport()
        var iterator = tm.events.makeAsyncIterator()

        // Transient failures must stay silent at the event layer (the old
        // pairing-wipe incident started with transient closes being surfaced
        // as auth failures). The rejection after them must be the FIRST event
        // on the stream — proving the transients yielded nothing.
        tm.applyLANAuthOutcome(.transient, host: "192.168.1.10", port: 8422)
        tm.applyLANAuthOutcome(.transient, host: "192.168.1.10", port: 8422)
        tm.applyLANAuthOutcome(.rejected, host: "192.168.1.10", port: 8422)

        let event = await iterator.next()
        guard case .lanAuthRejected = event else {
            return XCTFail("First stream event must be .lanAuthRejected — transient outcomes must not yield events; got \(String(describing: event))")
        }
    }
}

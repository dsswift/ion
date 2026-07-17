import XCTest
@testable import IonRemote

/// Pins the LAN auto-reconnect backoff ladder. Pre-backoff, the Bonjour
/// observation loop re-attempted a failing LAN auth on every ~500ms tick,
/// which repeatedly re-tripped the desktop's auth-failure cooldown (close
/// 1008) so a recoverable outage never recovered.
final class LANReconnectBackoffTests: XCTestCase {

    func testDelayProgressionEscalatesAndCapsAt30s() {
        var backoff = LANReconnectBackoff()
        // Attempts 1..5 walk the ladder; every attempt beyond stays at the cap.
        XCTAssertEqual(backoff.recordFailure(), 1)
        XCTAssertEqual(backoff.recordFailure(), 2)
        XCTAssertEqual(backoff.recordFailure(), 5)
        XCTAssertEqual(backoff.recordFailure(), 10)
        XCTAssertEqual(backoff.recordFailure(), 30)
        XCTAssertEqual(backoff.recordFailure(), 30, "Delay must cap at 30s, not keep growing")
        XCTAssertEqual(backoff.recordFailure(), 30)
        XCTAssertEqual(backoff.consecutiveFailures, 7)
    }

    func testResetReturnsToFirstDelay() {
        var backoff = LANReconnectBackoff()
        _ = backoff.recordFailure()
        _ = backoff.recordFailure()
        _ = backoff.recordFailure()
        backoff.reset()
        XCTAssertEqual(backoff.consecutiveFailures, 0)
        XCTAssertEqual(backoff.recordFailure(), 1,
            "After a successful auth the next failure must start the ladder over at 1s")
    }

    func testFreshBackoffHasNoFailures() {
        let backoff = LANReconnectBackoff()
        XCTAssertEqual(backoff.consecutiveFailures, 0)
    }
}

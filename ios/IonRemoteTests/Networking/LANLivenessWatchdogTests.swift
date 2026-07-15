import XCTest
import CryptoKit
@testable import IonRemote

/// Regression test for the LAN liveness watchdog.
///
/// A LAN TCP connection can wedge silently: the socket never delivers a FIN,
/// so the receive loop never ends and no `peerDisconnected` is emitted, leaving
/// iOS frozen on a dead connection. The watchdog fixes this by monitoring
/// heartbeat liveness — if two heartbeat intervals pass with no heartbeat, it
/// forces a reconnect+sync by yielding `.peerDisconnected`.
///
/// This test starves the watchdog: it sets `lastHeartbeatAt` far in the past,
/// starts the watchdog on a short (test) interval, and asserts `.peerDisconnected`
/// fires. On code without the watchdog, no such event is emitted and the test
/// times out (fails).
final class LANLivenessWatchdogTests: XCTestCase {

    private func makeManager() -> TransportManager {
        TransportManager(sharedKey: SymmetricKey(size: .bits256), deviceId: "dev-1")
    }

    func testStarvedHeartbeatTriggersPeerDisconnected() async throws {
        let m = makeManager()

        // Simulate starvation: the last heartbeat was 45s ago, well past the
        // (test) 0.2s interval the watchdog will use.
        m.lastHeartbeatAt = Date().addingTimeInterval(-45)

        // Collect events from the transport's stream.
        let received = expectation(description: "peerDisconnected fired")
        let collector = Task {
            for await event in m.events {
                if case .peerDisconnected = event {
                    received.fulfill()
                    return
                }
            }
        }

        // Start the watchdog on a short cadence so the test completes quickly.
        m.startLANHeartbeatWatchdog(intervalSeconds: 0.2)

        await fulfillment(of: [received], timeout: 3.0)
        collector.cancel()
        m.stopLANHeartbeatWatchdog()
    }

    func testFreshHeartbeatDoesNotTriggerDisconnect() async throws {
        let m = makeManager()

        // Simulate an alive connection: heartbeats keep arriving throughout the
        // observation window, so the watchdog must never see starvation.
        m.lastHeartbeatAt = Date()

        var fired = false
        let collector = Task {
            for await event in m.events {
                if case .peerDisconnected = event { fired = true; return }
            }
        }

        // Keep refreshing the heartbeat faster than the watchdog interval,
        // mimicking a healthy stream of heartbeats.
        let refresher = Task {
            for _ in 0..<12 {
                m.lastHeartbeatAt = Date()
                try? await Task.sleep(for: .milliseconds(50))
            }
        }

        m.startLANHeartbeatWatchdog(intervalSeconds: 0.2)
        // Span several watchdog ticks; a continuously-refreshed heartbeat keeps
        // it quiet the whole time.
        try await Task.sleep(for: .milliseconds(650))
        refresher.cancel()
        collector.cancel()
        m.stopLANHeartbeatWatchdog()

        XCTAssertFalse(fired, "watchdog must not fire while heartbeats are fresh")
    }
}

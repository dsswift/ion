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
/// This test starves the watchdog: it sets `lastLANFrameAt` far in the past,
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
        m.lastLANFrameAt = Date().addingTimeInterval(-45)

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
        m.lastLANFrameAt = Date()

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
                m.lastLANFrameAt = Date()
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

    // MARK: - Post-resume probe

    /// The probe window must cover at least one full desktop heartbeat
    /// interval (15s). The old 3s window condemned healthy sockets: the
    /// desktop's heartbeat phase is arbitrary relative to the resume moment,
    /// so on an idle-inbound connection the chance a heartbeat landed inside
    /// 3s of a 15s cadence was ~20% — the rest of the time the probe tore
    /// down a perfectly good LAN socket, re-authed, and repeated (the
    /// create-tab "not connected" flap). Red on the unfixed 3s constant.
    func testResumeProbeWindowCoversHeartbeatInterval() {
        XCTAssertGreaterThanOrEqual(TransportManager.resumeProbeWindowSeconds, 15.0,
            "Resume probe must wait at least one full desktop heartbeat interval (15s) before condemning the LAN socket")
    }

    /// A LAN frame arriving during the probe window keeps the socket: no
    /// teardown, no `.peerDisconnected`. Uses the injectable window on a
    /// short cadence.
    func testResumeProbeSatisfiedByLanFrame() async throws {
        let m = makeManager()
        m.setState(.lanPreferred)

        var fired = false
        let collector = Task {
            for await event in m.events {
                if case .peerDisconnected = event { fired = true; return }
            }
        }

        m.revalidateLANAfterResume(windowSeconds: 0.3)
        // Proof of life arrives mid-window (any LAN frame advances the mark;
        // the receive path calls this for every decrypted LAN frame).
        try? await Task.sleep(for: .milliseconds(100))
        m.lastLANFrameAt = Date()

        // Wait past the probe deadline; it must NOT have torn anything down.
        try? await Task.sleep(for: .milliseconds(400))
        collector.cancel()
        XCTAssertFalse(fired, "A LAN frame inside the probe window must keep the socket")
    }

    /// No LAN frame during the probe window: the probe tears the LAN down
    /// (no relay in this test, so `.peerDisconnected` is the signal).
    func testResumeProbeStarvedTearsDownLan() async throws {
        let m = makeManager()
        m.setState(.lanPreferred)

        let received = expectation(description: "peerDisconnected fired")
        let collector = Task {
            for await event in m.events {
                if case .peerDisconnected = event {
                    received.fulfill()
                    return
                }
            }
        }

        m.revalidateLANAfterResume(windowSeconds: 0.2)

        await fulfillment(of: [received], timeout: 3.0)
        collector.cancel()
    }
}

import XCTest
import CryptoKit
@testable import IonRemote

/// Pins the LAN heartbeat watchdog re-arm + teardown state machine.
///
/// Pre-fix defects this file guards against:
///  - On fire, the one-shot task returned WITHOUT nilling
///    `lanHeartbeatWatchdogTask`, so the `guard == nil` blocked every restart
///    for the transport's lifetime.
///  - The watchdog only armed on the FIRST LAN heartbeat, so a LAN death
///    before any heartbeat was never detected.
///  - On fire it only yielded `.peerDisconnected` without tearing the dead
///    NWConnection down, so state stayed `.lanPreferred` forever.
final class LANHeartbeatWatchdogTests: XCTestCase {

    private func makeManager() -> TransportManager {
        TransportManager(
            relayURL: URL(string: "wss://relay.example.com")!,
            apiKey: "k",
            channelId: "chan",
            sharedKey: SymmetricKey(size: .bits256)
        )
    }

    private func waitUntil(
        timeout: TimeInterval = 2.0,
        _ condition: @escaping () -> Bool
    ) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return condition()
    }

    // MARK: - Re-arm after fire

    func testWatchdogNilsTaskOnFireAndCanRearm() async {
        let m = makeManager()
        m.startLANHeartbeatWatchdog(intervalSeconds: 0.05)
        XCTAssertNotNil(m.lanHeartbeatWatchdogTask, "Watchdog must arm")

        // No heartbeat arrives within the interval -> the watchdog fires.
        let fired = await waitUntil { m.lanHeartbeatWatchdogTask == nil }
        XCTAssertTrue(fired,
            "On fire the watchdog must nil its task so a later LAN connection can re-arm")

        // Re-arm must succeed (pre-fix the stale task blocked this forever).
        m.startLANHeartbeatWatchdog(intervalSeconds: 30.0)
        XCTAssertNotNil(m.lanHeartbeatWatchdogTask,
            "startLANHeartbeatWatchdog must arm again after a previous fire")
        m.stopLANHeartbeatWatchdog()
    }

    // MARK: - Arm on transport activation, not first heartbeat

    func testWatchdogArmsWhenLanBecomesActiveTransport() {
        let m = makeManager()
        XCTAssertNil(m.lanHeartbeatWatchdogTask)

        // Entering .lanPreferred must arm the watchdog immediately — a LAN
        // socket that dies before its first heartbeat is still detected.
        m.setState(.lanPreferred)
        XCTAssertNotNil(m.lanHeartbeatWatchdogTask,
            "Watchdog must arm the moment LAN becomes the active transport")

        // Leaving .lanPreferred must disarm it.
        m.setState(.relayOnly)
        XCTAssertNil(m.lanHeartbeatWatchdogTask,
            "Watchdog must disarm when LAN stops being the active transport")
    }

    func testArmingBaselinesHeartbeatClock() {
        let m = makeManager()
        XCTAssertEqual(m.lastHeartbeatAt, .distantPast, "precondition")
        let before = Date()
        m.startLANHeartbeatWatchdog(intervalSeconds: 30.0)
        XCTAssertGreaterThanOrEqual(m.lastHeartbeatAt, before,
            "Arming must baseline the liveness clock so a stale timestamp from a previous LAN session cannot fire the watchdog instantly")
        m.stopLANHeartbeatWatchdog()
    }

    // MARK: - Fire tears down the dead LAN connection

    func testFireTearsDownLanAndSignalsPeerDisconnected() async {
        let m = makeManager()
        // Consume the events stream so we can observe the recovery signal.
        let events = OSAllocatedUnfairLockBox<[RemoteEvent]>([])
        Task {
            for await event in m.events {
                events.mutate { $0.append(event) }
            }
        }

        m.currentLANHost = DiscoveredHost(
            id: "lan-direct:10.0.0.2:9999",
            kind: .ionDirect,
            name: "TestMac",
            host: "10.0.0.2",
            port: 9999
        )
        m.startLANHeartbeatWatchdog(intervalSeconds: 0.05)

        let fired = await waitUntil { m.lanHeartbeatWatchdogTask == nil }
        XCTAssertTrue(fired, "Watchdog must fire with no heartbeats")

        XCTAssertNil(m.currentLANHost,
            "Fire must clear the current LAN host so Bonjour observation reconnects")
        // No relay is connected in this test, so the recovery signal is
        // .peerDisconnected (with relay up, relay takes over silently).
        let signaled = await waitUntil {
            events.value.contains { if case .peerDisconnected = $0 { return true } else { return false } }
        }
        XCTAssertTrue(signaled,
            "With no relay fallback the watchdog fire must signal .peerDisconnected")
    }
}

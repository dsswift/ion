import XCTest
@testable import IonRemote

/// Regression test for the pairing-wipe incident: after a re-pair, the
/// desktop's LAN auth cooldown closed the fresh iOS socket instantly. The
/// old code collapsed every auth failure into one Bool, so `connectLAN`
/// set `.authFailed` — and the app-level reaction to `.authFailed` wiped
/// every paired device and the entire keychain.
///
/// The fixed contract, pinned here: a *transient* LAN auth failure (the
/// socket never connects / drops without a verdict from the desktop) must
/// NOT produce `.authFailed`. `connectLAN` retries in place, then hands off
/// to the reconnect machinery with `connectionState == .disconnected`, the
/// transport torn down, and `pairedDevices` untouched.
///
/// On the unfixed code the final state is `.authFailed`, so the
/// `.disconnected` assertion fails — this is a true regression test.
@MainActor
final class SessionViewModelLanAuthTransientTests: XCTestCase {

    private var savedActiveDeviceId: String?

    override func setUp() {
        super.setUp()
        savedActiveDeviceId = UserDefaults.standard.string(forKey: "activeDeviceId")
    }

    override func tearDown() {
        UserDefaults.standard.set(savedActiveDeviceId, forKey: "activeDeviceId")
        super.tearDown()
    }

    private func makeDevice(id: String) -> PairedDevice {
        PairedDevice(
            id: id,
            name: "TestDesktop",
            pairedAt: Date(),
            lastSeen: nil,
            channelId: "chan-test",
            sharedSecret: Data(repeating: 7, count: 32),
            relayURL: "ws://127.0.0.1:1",
            relayAPIKey: "lan-direct",
            apnsToken: nil,
            customName: nil,
            customIcon: nil,
            remoteDisplayUpdatedAt: nil
        )
    }

    func testTransientLanAuthFailureNeverProducesAuthFailedAndKeepsPairings() async {
        let vm = SessionViewModel()
        let device = makeDevice(id: "device-transient-test")
        vm.pairedDevices = [device]
        vm.activeDeviceId = device.id
        // Shrink the production 2s/5s in-place retry delays so the test
        // exercises the full retry loop without wall-clock cost.
        vm.lanAuthRetryDelays = [.milliseconds(50), .milliseconds(50)]

        // Nothing listens on 127.0.0.1:1 — every attempt is a socket-level
        // connection failure with no close frame and no auth verdict from
        // any desktop: the canonical *transient* failure.
        vm.connectLAN(host: "127.0.0.1", port: 1)

        // Wait for the connect task to run its retries and settle, recording
        // every state observed so an .authFailed flip is caught even if the
        // terminal state were later overwritten.
        var sawAuthFailed = false
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline {
            if vm.connectionState == .authFailed { sawAuthFailed = true }
            if vm.connectionState == .disconnected { break }
            try? await Task.sleep(for: .milliseconds(10))
        }

        XCTAssertFalse(sawAuthFailed,
            "A transient LAN auth failure must never surface as .authFailed — that state routes to the pairing screen and once triggered a full pairing wipe")
        XCTAssertEqual(vm.connectionState, .disconnected,
            "Transient failure must settle in .disconnected (reconnect machinery territory), not .authFailed")
        XCTAssertNil(vm.transport,
            "Transport must be torn down after the transient hand-off")
        XCTAssertEqual(vm.pairedDevices.map(\.id), [device.id],
            "Paired devices must survive a transient auth failure untouched")

        // Cleanup: cancel the reconnect safety timer / event listeners started
        // by connectLAN so nothing outlives the test.
        vm.disconnect()
    }
}

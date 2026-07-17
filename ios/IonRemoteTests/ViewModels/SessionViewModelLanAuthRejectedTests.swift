import XCTest
@testable import IonRemote

/// Regression test for the "reconnecting forever" incident: the desktop
/// definitively rejected this device's identity (close 4003 "unknown device")
/// during Bonjour auto-reconnect, but the app sat on "reconnecting" forever
/// because nothing surfaced the rejection to the ViewModel.
///
/// The fixed contract, pinned here: the transport's `.lanAuthRejected` event
/// sets `connectionState == .authFailed` (which routes to the pairing screen
/// in IonRemoteApp), tears the transport down, cancels the reconnect safety
/// timer (so it cannot softReconnect the same dead identity behind the
/// pairing screen) — and leaves `pairedDevices` untouched (the `.authFailed`
/// route must never repeat the pairing-wipe incident, see
/// SessionViewModelLanAuthTransientTests).
///
/// On the unfixed code `.lanAuthRejected` does not exist and the state stays
/// `.reconnecting` — the `.authFailed` assertion fails.
@MainActor
final class SessionViewModelLanAuthRejectedTests: XCTestCase {

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

    func testLanAuthRejectedSetsAuthFailedAndKeepsPairings() {
        let vm = SessionViewModel()
        let device = makeDevice(id: "device-rejected-test")
        let bystander = makeDevice(id: "device-bystander")
        vm.pairedDevices = [device, bystander]
        vm.activeDeviceId = device.id
        // Simulate the live incident's shape: the app was stuck reconnecting
        // with an armed safety timer when the definitive rejection arrived.
        vm.connectionState = .reconnecting
        vm.startReconnectSafetyTimer()

        vm.handleEvent(.lanAuthRejected)

        XCTAssertEqual(vm.connectionState, .authFailed,
            "A definitive identity rejection must route to the pairing screen via .authFailed — on the unfixed code the app sat on reconnecting forever")
        XCTAssertEqual(vm.pairedDevices.map(\.id), [device.id, bystander.id],
            ".authFailed must never wipe pairedDevices — that is the pairing-wipe incident")
        XCTAssertNil(vm.transport,
            "Transport must be torn down so nothing keeps retrying the dead identity")
        XCTAssertNil(vm.reconnectSafetyTask,
            "The reconnect safety timer must be cancelled — it would softReconnect the dead identity behind the pairing screen")

        vm.disconnect()
    }
}

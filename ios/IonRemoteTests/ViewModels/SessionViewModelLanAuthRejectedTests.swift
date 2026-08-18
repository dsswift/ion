import XCTest
@testable import IonRemote

/// Regression test for LAN-pairing rejection while the relay path remains
/// independently authenticated. LAN and relay validate different credentials;
/// a LAN-only pairing failure must never overwrite relay/OIDC access state or
/// turn a successful account login into a loop.
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

    func testLanAuthRejectedKeepsPairingAvailableForRelayRecovery() {
        let vm = SessionViewModel()
        let device = makeDevice(id: "device-rejected-test")
        let bystander = makeDevice(id: "device-bystander")
        vm.pairedDevices = [device, bystander]
        vm.activeDeviceId = device.id
        vm.connectionState = .reconnecting

        vm.handleEvent(.lanAuthRejected)

        XCTAssertNotEqual(vm.activeDesktopAccess.status, .rejected,
            "A LAN-only rejection must not overwrite independent relay/OIDC authentication")
        XCTAssertNotEqual(vm.activeDesktopAccess.reason, .pairingRejected)
        XCTAssertEqual(vm.pairedDevices.map(\.id), [device.id, bystander.id],
            "LAN rejection must not remove or lock a pairing before relay verification")
        XCTAssertNotNil(vm.reconnectSafetyTask,
            "Transport recovery remains active after a LAN-only rejection")

        vm.disconnect()
    }
}

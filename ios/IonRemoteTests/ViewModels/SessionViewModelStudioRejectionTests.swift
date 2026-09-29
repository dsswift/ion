import XCTest
import CryptoKit
@testable import IonRemote

/// A credential refused on the Studio wire locks the pairing as rejected.
///
/// On the `desktop_*` wire a LAN rejection says nothing about the relay, so the
/// view model marks the desktop transiently disconnected and reconnects. One
/// credential serves every Studio route, so the same reaction there would dial
/// a refused pairing forever.
@MainActor
final class SessionViewModelStudioRejectionTests: XCTestCase {

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
        var device = PairedDevice(
            id: id, name: "TestServer", pairedAt: Date(), lastSeen: nil, channelId: "chan-test",
            sharedSecret: Data(repeating: 7, count: 32), relayURL: nil, relayAPIKey: nil
        )
        device.desktopAccess = ServerAccessRecord(status: .authorized, reason: .none, changedAt: Date(), lastAuthorizedAt: Date())
        return device
    }

    func testARefusedStudioCredentialLocksThePairingAndStopsDialing() async {
        let vm = SessionViewModel()
        let device = makeDevice(id: "device-studio-rejected")
        vm.pairedDevices = [device]
        vm.activeDeviceId = device.id
        let connection = FakeStudioConnection()
        vm.transport = StudioTransport(deviceId: device.id, connection: connection)

        vm.handleEvent(.lanAuthRejected)

        XCTAssertNil(vm.transport)
        XCTAssertNil(vm.reconnectSafetyTask, "a refused pairing must not schedule a reconnect")
        let access = vm.pairedDevices.first?.desktopAccess
        XCTAssertEqual(access?.status, .rejected)
        XCTAssertEqual(access?.reason, .pairingRejected)
        XCTAssertEqual(vm.pairedDevices.map(\.id), [device.id], "the pairing is locked, not deleted")
        await waitUntil("connection stopped") { connection.stopCount == 1 }
    }

}

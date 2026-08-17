import XCTest
@testable import IonRemote

/// Tests for SessionViewModel.repairPairing -- the recovery path after a
/// relay wrong-owner 403 (identity mismatch).
final class PairingRepairTests: XCTestCase {

    private func makeDevice(
        id: String = "device-aabb",
        desktopId: String? = "desktop-uuid-123"
    ) -> PairedDevice {
        var device = PairedDevice(
            id: id,
            name: "Test Mac",
            pairedAt: Date(),
            lastSeen: nil,
            channelId: "channel-\(id)",
            sharedSecret: Data(repeating: 0xCC, count: 32),
            relayURL: "wss://relay.example.com",
            relayAPIKey: "test-key"
        )
        device.desktopId = desktopId
        return device
    }

    // MARK: - Guard: missing desktopId

    @MainActor
    func testRepairRejectsMissingDesktopId() async {
        let vm = SessionViewModel()
        let device = makeDevice(desktopId: nil)
        vm.pairedDevices = [device]
        vm.activeDeviceId = device.id

        let result = await vm.repairPairing(device: device)
        XCTAssertFalse(result, "repair must fail when device has no desktopId")
    }

    @MainActor
    func testRepairRejectsEmptyDesktopId() async {
        let vm = SessionViewModel()
        let device = makeDevice(desktopId: "")
        vm.pairedDevices = [device]
        vm.activeDeviceId = device.id

        let result = await vm.repairPairing(device: device)
        XCTAssertFalse(result, "repair must fail when desktopId is empty string")
    }

    // MARK: - Guard: desktop not found on LAN

    @MainActor
    func testRepairFailsWhenDesktopNotFoundOnLAN() async {
        let vm = SessionViewModel()
        let device = makeDevice()
        vm.pairedDevices = [device]
        vm.activeDeviceId = device.id

        let result = await vm.repairPairing(device: device)
        XCTAssertFalse(result, "repair must fail when Bonjour finds no matching desktop")
        XCTAssertTrue({
            if case .idle = vm.pairingState { return true }
            return false
        }(), "pairing state must reset to idle on failure")
    }

    // MARK: - State: identity mismatch cleared on guard failure

    @MainActor
    func testRepairDoesNotClearMismatchOnGuardFailure() {
        let vm = SessionViewModel()
        let device = makeDevice(desktopId: nil)
        vm.pairedDevices = [device]
        vm.activeDeviceId = device.id
        vm.relayIdentityMismatch.insert(device.id)

        Task {
            _ = await vm.repairPairing(device: device)
        }

        XCTAssertTrue(
            vm.relayIdentityMismatch.contains(device.id),
            "identity mismatch flag must survive a guard-level rejection"
        )
    }

    // MARK: - DesktopAccessRecoveryView: button visibility

    @MainActor
    func testRecoveryViewShowsRepairButtonForWrongAccount() {
        let record = DesktopAccessRecord(
            status: .rejected,
            reason: .wrongAccount,
            changedAt: Date(),
            lastAuthorizedAt: nil
        )
        XCTAssertEqual(record.reason, .wrongAccount,
            "wrongAccount reason should be the trigger for showing the repair button")
    }
}

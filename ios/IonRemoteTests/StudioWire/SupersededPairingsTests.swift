import XCTest
@testable import IonRemote

/// Pairing a second time with a server this phone already holds replaces the
/// first pairing. Kept beside it, the server showed twice in every list of
/// paired servers, one of them with a credential that no longer worked.
final class SupersededPairingsTests: XCTestCase {

    private var selectionBefore: String?

    override func setUp() {
        super.setUp()
        selectionBefore = UserDefaults.standard.string(forKey: DiagnosticLog.selectedPairingDefaultsKey)
    }

    override func tearDown() {
        UserDefaults.standard.set(selectionBefore, forKey: DiagnosticLog.selectedPairingDefaultsKey)
        super.tearDown()
    }

    private func secret(_ byte: UInt8) -> Data { Data(repeating: byte, count: 32) }

    /// A pairing made on the Studio wire: the device and its record share an id.
    private func pairing(
        _ byte: UInt8, environmentId: String?, pairedAt: TimeInterval
    ) -> (device: PairedDevice, record: StudioServerRecord) {
        let clientId = StudioServerRecord.clientId(forSecret: secret(byte))
        let device = PairedDevice(
            id: clientId, name: "studio-host", pairedAt: Date(timeIntervalSince1970: pairedAt), lastSeen: nil,
            channelId: "unused", sharedSecret: secret(byte), relayURL: nil, relayAPIKey: nil
        )
        let record = StudioServerRecord(
            clientId: clientId, secret: secret(byte), url: nil, environmentId: environmentId,
            machineId: nil, label: "studio-host", relays: [], pairedDeviceId: clientId
        )
        return (device, record)
    }

    // MARK: - Finding

    func testTheOlderOfTwoPairingsToOneServerIsStale() {
        let first = pairing(1, environmentId: "env-a", pairedAt: 100)
        let other = pairing(2, environmentId: "env-b", pairedAt: 150)
        let again = pairing(3, environmentId: "env-a", pairedAt: 200)

        let stale = SupersededPairings.find(
            devices: [first.device, other.device, again.device],
            records: [first.record, other.record, again.record]
        )

        XCTAssertEqual(stale, [
            SupersededPairings.Stale(deviceId: first.device.id, clientId: first.record.clientId, keptDeviceId: again.device.id)
        ])
    }

    func testTheNewestIsKeptWhateverTheListOrder() {
        let again = pairing(3, environmentId: "env-a", pairedAt: 200)
        let first = pairing(1, environmentId: "env-a", pairedAt: 100)

        let stale = SupersededPairings.find(devices: [again.device, first.device], records: [again.record, first.record])

        XCTAssertEqual(stale.map(\.deviceId), [first.device.id])
        XCTAssertEqual(stale.map(\.keptDeviceId), [again.device.id])
    }

    func testPairingsToDifferentServersAreAllKept() {
        let one = pairing(1, environmentId: "env-a", pairedAt: 100)
        let two = pairing(2, environmentId: "env-b", pairedAt: 200)

        XCTAssertTrue(SupersededPairings.find(devices: [one.device, two.device], records: [one.record, two.record]).isEmpty)
    }

    func testAPairingWhoseServerIsNotYetKnownIsNeverStale() {
        let unknown = pairing(1, environmentId: nil, pairedAt: 100)
        let alsoUnknown = pairing(2, environmentId: nil, pairedAt: 200)
        let empty = pairing(3, environmentId: "", pairedAt: 300)
        let noRecord = pairing(4, environmentId: "env-a", pairedAt: 50)
        let known = pairing(5, environmentId: "env-a", pairedAt: 400)

        let stale = SupersededPairings.find(
            devices: [unknown.device, alsoUnknown.device, empty.device, noRecord.device, known.device],
            records: [unknown.record, alsoUnknown.record, empty.record, known.record]
        )

        XCTAssertTrue(stale.isEmpty)
    }

    // MARK: - Dropping

    @MainActor
    func testDroppingRemovesTheOlderPairingAndItsCredentialAndMovesTheSelection() {
        let first = pairing(1, environmentId: "env-a", pairedAt: 100)
        let other = pairing(2, environmentId: "env-b", pairedAt: 150)
        let again = pairing(3, environmentId: "env-a", pairedAt: 200)
        let store = MemoryStudioServerStore([first.record, other.record, again.record])
        let vm = SessionViewModel()
        vm.pairedDevices = [first.device, other.device, again.device]
        vm.activeDeviceId = first.device.id
        vm.deviceOnlineStatus[first.device.id] = true

        let dropped = vm.dropSupersededPairings(store: store)

        XCTAssertEqual(dropped.map(\.deviceId), [first.device.id])
        XCTAssertEqual(vm.pairedDevices.map(\.id), [other.device.id, again.device.id])
        XCTAssertEqual(store.stored.map(\.clientId), [other.record.clientId, again.record.clientId])
        XCTAssertEqual(vm.activeDeviceId, again.device.id, "the selection follows the server to its newer pairing")
        XCTAssertNil(vm.deviceOnlineStatus[first.device.id])
    }

    @MainActor
    func testAnotherServersSelectionIsLeftAlone() {
        let first = pairing(1, environmentId: "env-a", pairedAt: 100)
        let other = pairing(2, environmentId: "env-b", pairedAt: 150)
        let again = pairing(3, environmentId: "env-a", pairedAt: 200)
        let store = MemoryStudioServerStore([first.record, other.record, again.record])
        let vm = SessionViewModel()
        vm.pairedDevices = [first.device, other.device, again.device]
        vm.activeDeviceId = other.device.id

        vm.dropSupersededPairings(store: store)

        XCTAssertEqual(vm.activeDeviceId, other.device.id)
    }

    @MainActor
    func testAPairingWhoseCredentialCannotBeRemovedStaysListed() {
        let first = pairing(1, environmentId: "env-a", pairedAt: 100)
        let again = pairing(3, environmentId: "env-a", pairedAt: 200)
        let store = MemoryStudioServerStore([first.record, again.record])
        store.failsSave = true
        let vm = SessionViewModel()
        vm.pairedDevices = [first.device, again.device]

        XCTAssertTrue(vm.dropSupersededPairings(store: store).isEmpty)
        XCTAssertEqual(vm.pairedDevices.map(\.id), [first.device.id, again.device.id])
    }

    @MainActor
    func testNothingIsStoredWhenNoPairingIsStale() {
        let one = pairing(1, environmentId: "env-a", pairedAt: 100)
        let two = pairing(2, environmentId: "env-b", pairedAt: 200)
        let store = MemoryStudioServerStore([one.record, two.record])
        let vm = SessionViewModel()
        vm.pairedDevices = [one.device, two.device]

        XCTAssertTrue(vm.dropSupersededPairings(store: store).isEmpty)
        XCTAssertEqual(store.saveCount, 0)
        XCTAssertEqual(vm.pairedDevices.count, 2)
    }
}

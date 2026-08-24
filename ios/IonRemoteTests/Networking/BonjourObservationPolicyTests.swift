import XCTest
import CryptoKit
import Network
@testable import IonRemote

/// Pins the Bonjour observation policy for a device that has relay access but
/// no Bonjour-capable local interface. The old loop polled and logged every
/// 500 ms in that state; these direct policy seams prove it now stays stopped
/// until Wi-Fi or wired Ethernet returns.
final class BonjourObservationPolicyTests: XCTestCase {

    private func makeLANOnlyTransport() -> TransportManager {
        TransportManager(sharedKey: SymmetricKey(size: .bits256), deviceId: "device-under-test")
    }

    func testBonjourRequiresSatisfiedWiFiOrWiredEthernet() {
        let transport = makeLANOnlyTransport()

        XCTAssertTrue(transport.isBonjourInterfaceAvailable(
            status: .satisfied,
            usesWiFi: true,
            usesWiredEthernet: false
        ))
        XCTAssertTrue(transport.isBonjourInterfaceAvailable(
            status: .satisfied,
            usesWiFi: false,
            usesWiredEthernet: true
        ))
        XCTAssertFalse(transport.isBonjourInterfaceAvailable(
            status: .satisfied,
            usesWiFi: false,
            usesWiredEthernet: false
        ), "Cellular-only connectivity cannot discover Bonjour hosts")
        XCTAssertFalse(transport.isBonjourInterfaceAvailable(
            status: .unsatisfied,
            usesWiFi: true,
            usesWiredEthernet: false
        ))
    }

    func testUnavailableInterfaceCancelsObservationOnlyOnce() {
        let transport = makeLANOnlyTransport()
        transport.bonjourObservationTask = Task {}
        transport.lastBonjourNeedsConnect = true

        transport.handleBonjourInterfaceAvailability(false)

        XCTAssertEqual(transport.bonjourInterfaceAvailable, false)
        XCTAssertNil(transport.bonjourObservationTask)
        XCTAssertNil(transport.lastBonjourNeedsConnect)

        // A repeated unavailable path update must not recreate or cancel work.
        transport.handleBonjourInterfaceAvailability(false)
        XCTAssertNil(transport.bonjourObservationTask)
    }

    func testAvailableInterfaceStartsObservationImmediately() {
        let transport = makeLANOnlyTransport()
        transport.handleBonjourInterfaceAvailability(false)

        transport.handleBonjourInterfaceAvailability(true)

        XCTAssertEqual(transport.bonjourInterfaceAvailable, true)
        XCTAssertNotNil(transport.bonjourObservationTask)
        transport.bonjourObservationTask?.cancel()
    }

    func testNeedsConnectDiagnosticChangesOnlyOnStateTransition() {
        let transport = makeLANOnlyTransport()

        XCTAssertTrue(transport.recordBonjourNeedsConnectTransition(true))
        XCTAssertFalse(transport.recordBonjourNeedsConnectTransition(true),
            "The old loop emitted this diagnostic on every 500ms poll")
        XCTAssertTrue(transport.recordBonjourNeedsConnectTransition(false))
        XCTAssertFalse(transport.recordBonjourNeedsConnectTransition(false))
    }
}

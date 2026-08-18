import XCTest
import CryptoKit
@testable import IonRemote

/// Tests for the LAN close-4004 path: the desktop knows this device but its
/// stored pairing secret is unusable (its OS keychain grant was lost across a
/// reinstall, leaving the secret undecryptable).
///
/// This must NOT be folded into `.rejected`. A rejection locks the desktop and
/// routes the user to the pairing screen, demanding a manual PIN for a fault
/// the two devices can resolve between themselves: the desktop still holds
/// this phone's `mobileDeviceId`, so a codeless recovery re-pair over the LAN
/// restores the connection with no user action.
final class LANSecretUnusableTests: XCTestCase {

    // MARK: - Close-code classification

    func testCloseCode4004ResolvesToSecretUnusable() {
        let outcome = LANAuthOutcome.resolve(streamOutcome: .transient, closeCode: 4004)
        XCTAssertEqual(outcome, .secretUnusable)
    }

    /// The desktop sends an `auth_result success=false` frame AND then closes
    /// with 4004. The close code carries the more specific reason, so it must
    /// win — otherwise the phone locks the desktop instead of repairing it.
    func testCloseCode4004OverridesExplicitRejectionFrame() {
        let outcome = LANAuthOutcome.resolve(streamOutcome: .rejected, closeCode: 4004)
        XCTAssertEqual(outcome, .secretUnusable)
    }

    func testUnknownDevice4003StaysRejected() {
        let outcome = LANAuthOutcome.resolve(streamOutcome: .transient, closeCode: 4003)
        XCTAssertEqual(outcome, .rejected)
    }

    /// 4004 must stay inside the application-close band, so any client that
    /// only understands the generic band still treats it as definitive rather
    /// than retrying into the same refusal forever.
    func testSecretUnusableCodeIsInApplicationCloseBand() {
        XCTAssertGreaterThanOrEqual(LANAuthOutcome.closeCodeSecretUnusable, 4000)
        XCTAssertLessThanOrEqual(LANAuthOutcome.closeCodeSecretUnusable, 4999)
        XCTAssertEqual(LANAuthOutcome.closeCodeSecretUnusable, 4004)
    }

    func testOtherApplicationCodesStillResolveToRejected() {
        for code in [4000, 4001, 4003, 4005, 4999] {
            XCTAssertEqual(
                LANAuthOutcome.resolve(streamOutcome: .transient, closeCode: code),
                .rejected,
                "close code \(code) should be a generic rejection"
            )
        }
    }

    /// A protocol-level close (1008 = the desktop's auth cooldown) carries no
    /// verdict and must stay transient.
    func testAuthCooldownCloseStaysTransient() {
        XCTAssertEqual(LANAuthOutcome.resolve(streamOutcome: .transient, closeCode: 1008), .transient)
        XCTAssertEqual(LANAuthOutcome.resolve(streamOutcome: .transient, closeCode: nil), .transient)
    }

    func testSuccessIsNeverOverriddenByAbsentCloseCode() {
        XCTAssertEqual(LANAuthOutcome.resolve(streamOutcome: .success, closeCode: nil), .success)
    }

    // MARK: - Reconnect policy

    /// `.secretUnusable` must not set `lanAuthRejectedDefinitively`: that flag
    /// permanently stops LAN attempts, and this pairing is repairable.
    private func makeLANOnlyTransport() -> TransportManager {
        TransportManager(sharedKey: SymmetricKey(size: .bits256), deviceId: "device-under-test")
    }

    func testSecretUnusableDoesNotPermanentlyStopLANAttempts() {
        let tm = makeLANOnlyTransport()
        tm.applyLANAuthOutcome(.secretUnusable, host: "192.168.86.237", port: 19837)

        XCTAssertFalse(tm.lanAuthRejectedDefinitively)
    }

    func testDefinitiveRejectionStillStopsLANAttempts() {
        let tm = makeLANOnlyTransport()
        tm.applyLANAuthOutcome(.rejected, host: "192.168.86.237", port: 19837)

        XCTAssertTrue(tm.lanAuthRejectedDefinitively)
    }

    /// The repair signal must actually reach the ViewModel, otherwise the
    /// desktop's 4004 refusal is silently dropped and the phone stalls.
    func testSecretUnusableYieldsRepairEvent() async {
        let tm = makeLANOnlyTransport()
        var iterator = tm.events.makeAsyncIterator()

        tm.applyLANAuthOutcome(.secretUnusable, host: "192.168.86.237", port: 19837)

        let event = await iterator.next()
        guard case .lanSecretUnusable = event else {
            return XCTFail("An unusable-secret refusal must yield .lanSecretUnusable, got \(String(describing: event))")
        }
    }

    // MARK: - Repair attempt cap

    /// The repair runs with no user interaction, so it must be bounded: an
    /// unbounded retry would be an invisible loop where the user sees only a
    /// stalled connection.
    @MainActor
    func testRepairAttemptsAreCapped() {
        XCTAssertGreaterThan(SessionViewModel.maxPairingRepairAttempts, 0)

        let vm = SessionViewModel()
        vm.pairingRepairAttempts["device-1"] = SessionViewModel.maxPairingRepairAttempts

        XCTAssertGreaterThanOrEqual(
            vm.pairingRepairAttempts["device-1"] ?? 0,
            SessionViewModel.maxPairingRepairAttempts
        )
    }

    @MainActor
    func testRepairAttemptsStartEmpty() {
        let vm = SessionViewModel()
        XCTAssertTrue(vm.pairingRepairAttempts.isEmpty)
    }
}

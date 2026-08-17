import XCTest
@testable import IonRemote

final class DesktopAccessPolicyTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_700_000_000)

    func testLegacyPairingStartsVisible() {
        XCTAssertTrue(DesktopAccessPolicy.mayViewDesktopData(nil))
        XCTAssertEqual(DesktopAccessPolicy.normalizedForLaunch(nil).status, .startup)
    }

    func testAuthorizedRecordNormalizesToTransientOnLaunch() {
        let record = DesktopAccessRecord(status: .authorized, reason: .none, changedAt: now, lastAuthorizedAt: now)
        let normalized = DesktopAccessPolicy.normalizedForLaunch(record)
        XCTAssertEqual(normalized.status, .transientlyDisconnected)
        XCTAssertEqual(normalized.lastAuthorizedAt, now)
        XCTAssertTrue(DesktopAccessPolicy.mayViewDesktopData(normalized))
    }

    func testTransientDisconnectDoesNotLock() {
        let record = DesktopAccessRecord(status: .transientlyDisconnected, reason: .none, changedAt: now, lastAuthorizedAt: now)
        XCTAssertTrue(DesktopAccessPolicy.mayViewDesktopData(record))
        XCTAssertFalse(DesktopAccessPolicy.mayMutate(record))
    }

    func testExplicitAuthenticationRequiredLocksData() {
        let record = DesktopAccessRecord(status: .authenticationRequired, reason: .userCancelled, changedAt: now, lastAuthorizedAt: now)
        XCTAssertFalse(DesktopAccessPolicy.mayViewDesktopData(record))
        XCTAssertFalse(DesktopAccessPolicy.mayNavigate(record))
        XCTAssertFalse(DesktopAccessPolicy.mayMutate(record))
        XCTAssertEqual(DesktopAccessPolicy.recoveryTitle(for: record), "Sign-in cancelled")
    }

    func testWrongAccountIsRejectedAndLocked() {
        let record = DesktopAccessRecord(status: .rejected, reason: .wrongAccount, changedAt: now, lastAuthorizedAt: now)
        XCTAssertFalse(DesktopAccessPolicy.mayViewDesktopData(record))
        XCTAssertEqual(DesktopAccessPolicy.recoveryTitle(for: record), "Wrong account for this desktop")
    }

    func testPairingRejectedHasRepairMessage() {
        let record = DesktopAccessRecord(status: .rejected, reason: .pairingRejected, changedAt: now, lastAuthorizedAt: nil)
        XCTAssertTrue(DesktopAccessPolicy.recoveryMessage(for: record).contains("repair"))
    }

    func testVerifyingAllowsViewingData() {
        let record = DesktopAccessRecord(status: .verifying, reason: .none, changedAt: now, lastAuthorizedAt: now)
        XCTAssertTrue(DesktopAccessPolicy.mayViewDesktopData(record))
        XCTAssertTrue(DesktopAccessPolicy.mayNavigate(record))
        XCTAssertFalse(DesktopAccessPolicy.mayMutate(record))
        XCTAssertTrue(DesktopAccessPolicy.isVerifying(record))
    }

    func testVerifyingNormalizesToTransientOnLaunch() {
        let record = DesktopAccessRecord(status: .verifying, reason: .none, changedAt: now, lastAuthorizedAt: now)
        let normalized = DesktopAccessPolicy.normalizedForLaunch(record)
        XCTAssertEqual(normalized.status, .transientlyDisconnected)
        XCTAssertEqual(normalized.lastAuthorizedAt, now)
    }

    func testIsVerifyingFalseForOtherStatuses() {
        XCTAssertFalse(DesktopAccessPolicy.isVerifying(nil))
        XCTAssertFalse(DesktopAccessPolicy.isVerifying(.startup()))
        let authorized = DesktopAccessRecord(status: .authorized, reason: .none, changedAt: now, lastAuthorizedAt: now)
        XCTAssertFalse(DesktopAccessPolicy.isVerifying(authorized))
    }

    func testNoTimeThresholdChangesAuthority() {
        let old = DesktopAccessRecord(status: .transientlyDisconnected, reason: .none, changedAt: .distantPast, lastAuthorizedAt: .distantPast)
        XCTAssertTrue(DesktopAccessPolicy.mayViewDesktopData(old), "Age is disclosure, not authority")
    }
}

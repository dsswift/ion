import XCTest
@testable import IonRemote

final class ServerAccessPolicyTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_700_000_000)

    func testLegacyPairingStartsVisible() {
        XCTAssertTrue(ServerAccessPolicy.mayViewServerData(nil))
        XCTAssertEqual(ServerAccessPolicy.normalizedForLaunch(nil).status, .startup)
    }

    func testAuthorizedRecordNormalizesToTransientOnLaunch() {
        let record = ServerAccessRecord(status: .authorized, reason: .none, changedAt: now, lastAuthorizedAt: now)
        let normalized = ServerAccessPolicy.normalizedForLaunch(record)
        XCTAssertEqual(normalized.status, .transientlyDisconnected)
        XCTAssertEqual(normalized.lastAuthorizedAt, now)
        XCTAssertTrue(ServerAccessPolicy.mayViewServerData(normalized))
    }

    func testTransientDisconnectDoesNotLock() {
        let record = ServerAccessRecord(status: .transientlyDisconnected, reason: .none, changedAt: now, lastAuthorizedAt: now)
        XCTAssertTrue(ServerAccessPolicy.mayViewServerData(record))
        XCTAssertFalse(ServerAccessPolicy.mayMutate(record))
    }

    func testExplicitAuthenticationRequiredLocksData() {
        let record = ServerAccessRecord(status: .authenticationRequired, reason: .userCancelled, changedAt: now, lastAuthorizedAt: now)
        XCTAssertFalse(ServerAccessPolicy.mayViewServerData(record))
        XCTAssertFalse(ServerAccessPolicy.mayNavigate(record))
        XCTAssertFalse(ServerAccessPolicy.mayMutate(record))
        XCTAssertEqual(ServerAccessPolicy.recoveryTitle(for: record), "Sign-in cancelled")
    }

    func testWrongAccountIsRejectedAndLocked() {
        let record = ServerAccessRecord(status: .rejected, reason: .wrongAccount, changedAt: now, lastAuthorizedAt: now)
        XCTAssertFalse(ServerAccessPolicy.mayViewServerData(record))
        XCTAssertEqual(ServerAccessPolicy.recoveryTitle(for: record), "Wrong account for this server")
    }

    func testPairingRejectedTellsTheUserToPairAgain() {
        let record = ServerAccessRecord(status: .rejected, reason: .pairingRejected, changedAt: now, lastAuthorizedAt: nil)
        XCTAssertTrue(ServerAccessPolicy.recoveryMessage(for: record).contains("pair again"))
    }

    func testVerifyingAllowsViewingData() {
        let record = ServerAccessRecord(status: .verifying, reason: .none, changedAt: now, lastAuthorizedAt: now)
        XCTAssertTrue(ServerAccessPolicy.mayViewServerData(record))
        XCTAssertTrue(ServerAccessPolicy.mayNavigate(record))
        XCTAssertFalse(ServerAccessPolicy.mayMutate(record))
        XCTAssertTrue(ServerAccessPolicy.isVerifying(record))
    }

    func testVerifyingNormalizesToTransientOnLaunch() {
        let record = ServerAccessRecord(status: .verifying, reason: .none, changedAt: now, lastAuthorizedAt: now)
        let normalized = ServerAccessPolicy.normalizedForLaunch(record)
        XCTAssertEqual(normalized.status, .transientlyDisconnected)
        XCTAssertEqual(normalized.lastAuthorizedAt, now)
    }

    func testIsVerifyingFalseForOtherStatuses() {
        XCTAssertFalse(ServerAccessPolicy.isVerifying(nil))
        XCTAssertFalse(ServerAccessPolicy.isVerifying(.startup()))
        let authorized = ServerAccessRecord(status: .authorized, reason: .none, changedAt: now, lastAuthorizedAt: now)
        XCTAssertFalse(ServerAccessPolicy.isVerifying(authorized))
    }

    func testNoTimeThresholdChangesAuthority() {
        let old = ServerAccessRecord(status: .transientlyDisconnected, reason: .none, changedAt: .distantPast, lastAuthorizedAt: .distantPast)
        XCTAssertTrue(ServerAccessPolicy.mayViewServerData(old), "Age is disclosure, not authority")
    }
}

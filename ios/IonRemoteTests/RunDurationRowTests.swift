import XCTest
@testable import IonRemote

final class RunDurationRowTests: XCTestCase {

    func testLabelsReflectCompletionReason() {
        XCTAssertEqual(RunDurationRow(durationMs: 999, reason: .normal).label, "Completed in <1s")
        XCTAssertEqual(RunDurationRow(durationMs: 62_007, reason: .aborted).label, "Stopped after 1m 2s")
        XCTAssertEqual(RunDurationRow(durationMs: 62_007, reason: .maxTurns).label, "Ended after 1m 2s")
        XCTAssertEqual(RunDurationRow(durationMs: 62_007, reason: .unknown("future")).label, "Ended after 1m 2s")
    }
}

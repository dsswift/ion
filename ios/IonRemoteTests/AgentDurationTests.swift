import XCTest
@testable import IonRemote

/// Tests for the AgentDuration shared helper.
/// Both AgentBarRow (compact header) and AgentExpandedContent (pinned header)
/// call this helper, so pinning its behavior here ensures neither surface can
/// silently diverge if the logic is later changed.
final class AgentDurationTests: XCTestCase {

    // MARK: - elapsedSeconds

    func test_elapsedSeconds_running_computesNowMinusStartTime() {
        let startTime: Double = 1_000_000
        let now = Date(timeIntervalSince1970: startTime + 75)
        let result = AgentDuration.elapsedSeconds(
            status: "running",
            startTime: startTime,
            elapsed: nil,
            now: now
        )
        XCTAssertEqual(result, 75)
    }

    func test_elapsedSeconds_running_clampsToZeroWhenNowBeforeStart() {
        let startTime: Double = 1_000_100
        let now = Date(timeIntervalSince1970: 1_000_000) // before startTime
        let result = AgentDuration.elapsedSeconds(
            status: "running",
            startTime: startTime,
            elapsed: nil,
            now: now
        )
        XCTAssertEqual(result, 0)
    }

    func test_elapsedSeconds_done_usesElapsedField() {
        let result = AgentDuration.elapsedSeconds(
            status: "done",
            startTime: 1_000_000,
            elapsed: 42.7,
            now: Date()
        )
        XCTAssertEqual(result, 42)
    }

    func test_elapsedSeconds_done_clampsToZeroWhenElapsedNegative() {
        let result = AgentDuration.elapsedSeconds(
            status: "done",
            startTime: nil,
            elapsed: -5,
            now: Date()
        )
        XCTAssertEqual(result, 0)
    }

    func test_elapsedSeconds_noData_returnsNil() {
        let result = AgentDuration.elapsedSeconds(
            status: "done",
            startTime: nil,
            elapsed: nil,
            now: Date()
        )
        XCTAssertNil(result)
    }

    func test_elapsedSeconds_running_noStartTime_returnsNil() {
        let result = AgentDuration.elapsedSeconds(
            status: "running",
            startTime: nil,
            elapsed: nil,
            now: Date()
        )
        XCTAssertNil(result)
    }

    // MARK: - formatMilliseconds

    func test_formatMilliseconds_matchesRunDurationContract() {
        XCTAssertEqual(AgentDuration.formatMilliseconds(-1), "<1s")
        XCTAssertEqual(AgentDuration.formatMilliseconds(0), "<1s")
        XCTAssertEqual(AgentDuration.formatMilliseconds(999), "<1s")
        XCTAssertEqual(AgentDuration.formatMilliseconds(1_000), "1s")
        XCTAssertEqual(AgentDuration.formatMilliseconds(62_007), "1m 2s")
        XCTAssertEqual(AgentDuration.formatMilliseconds(3_661_000), "1h 1m")
    }

    // MARK: - format

    func test_format_secondsUnder60() {
        XCTAssertEqual(AgentDuration.format(0),  "0s")
        XCTAssertEqual(AgentDuration.format(1),  "1s")
        XCTAssertEqual(AgentDuration.format(42), "42s")
        XCTAssertEqual(AgentDuration.format(59), "59s")
    }

    func test_format_minutesRange() {
        XCTAssertEqual(AgentDuration.format(60),   "1m 0s")
        XCTAssertEqual(AgentDuration.format(127),  "2m 7s")
        XCTAssertEqual(AgentDuration.format(3599), "59m 59s")
    }

    func test_format_hoursRange() {
        XCTAssertEqual(AgentDuration.format(3600),  "1h 0m")
        XCTAssertEqual(AgentDuration.format(3661),  "1h 1m")
        XCTAssertEqual(AgentDuration.format(7384),  "2h 3m")
    }
}

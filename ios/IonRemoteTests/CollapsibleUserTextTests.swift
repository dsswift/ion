import XCTest
@testable import IonRemote

final class CollapsibleUserTextTests: XCTestCase {
    func testLongByCharacterCountCollapses() {
        let text = String(repeating: "x", count: CollapsibleUserTextThreshold.maxLength + 1)
        XCTAssertTrue(CollapsibleUserTextThreshold.shouldCollapse(text))
    }

    func testLongByLineCountCollapses() {
        let text = (0...CollapsibleUserTextThreshold.maxLines).map { "line \($0)" }.joined(separator: "\n")
        XCTAssertTrue(CollapsibleUserTextThreshold.shouldCollapse(text))
    }

    func testShortMessageDoesNotCollapse() {
        XCTAssertFalse(CollapsibleUserTextThreshold.shouldCollapse("short message"))
    }

    func testWhitespaceOnlyDoesNotCollapse() {
        XCTAssertFalse(CollapsibleUserTextThreshold.shouldCollapse("   \n   \n  "))
    }

    func testThresholdsMatchDesktopParity() {
        // Pinned to the desktop CollapsibleUserBody constants (t3code parity):
        // a drift on either side is a cross-platform behavior divergence.
        XCTAssertEqual(CollapsibleUserTextThreshold.maxLength, 600)
        XCTAssertEqual(CollapsibleUserTextThreshold.maxLines, 8)
    }

    func testExactBoundaryDoesNotCollapse() {
        XCTAssertFalse(CollapsibleUserTextThreshold.shouldCollapse(
            String(repeating: "x", count: CollapsibleUserTextThreshold.maxLength)
        ))
        let exactLines = (1...CollapsibleUserTextThreshold.maxLines).map { "l\($0)" }.joined(separator: "\n")
        XCTAssertFalse(CollapsibleUserTextThreshold.shouldCollapse(exactLines))
    }
}

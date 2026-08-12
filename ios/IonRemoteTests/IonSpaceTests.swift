import XCTest
@testable import IonRemote

/// Pins the spacing and radius roles to the values the iOS style guide
/// specifies, and pins the two structural properties that make them worth
/// declaring at all: the spacing scale holds the cross-client 1:2:3:4:6:8
/// ratio, and the radius scale has exactly three steps.
final class IonSpaceTests: XCTestCase {

    // MARK: - Spacing roles

    func testSpacingRolesMatchSpecification() {
        XCTAssertEqual(IonSpace.hairlineGap, 4)
        XCTAssertEqual(IonSpace.compactGap, 8)
        XCTAssertEqual(IonSpace.contentGap, 12)
        XCTAssertEqual(IonSpace.rowInset, 16)
        XCTAssertEqual(IonSpace.sectionGap, 24)
        XCTAssertEqual(IonSpace.screenInset, 32)
    }

    /// Spacing is ratio-pinned across clients rather than value-pinned: the
    /// physical values stay native to iOS, but the 1:2:3:4:6:8 relationship
    /// does not. Changing a role to a value off that ratio breaks the shared
    /// rhythm even though it would look fine in isolation, so the ratio is
    /// asserted directly against the 4pt base unit.
    func testSpacingScaleHoldsTheCrossClientRatio() {
        let base = IonSpace.hairlineGap
        let steps: [(CGFloat, CGFloat)] = [
            (IonSpace.hairlineGap, 1),
            (IonSpace.compactGap, 2),
            (IonSpace.contentGap, 3),
            (IonSpace.rowInset, 4),
            (IonSpace.sectionGap, 6),
            (IonSpace.screenInset, 8),
        ]
        for (value, multiple) in steps {
            XCTAssertEqual(
                value,
                base * multiple,
                "spacing role \(value) is not \(multiple)x the 4pt base unit"
            )
        }
    }

    // MARK: - Radius roles

    func testRadiusRolesMatchSpecification() {
        XCTAssertEqual(IonRadius.control, 8)
        XCTAssertEqual(IonRadius.container, 12)
        XCTAssertEqual(IonRadius.sheet, 20)
    }

    /// The radius scale is deliberately three steps, collapsed from the shipped
    /// four. Re-adding a fourth (16pt in particular, which the user bubble used
    /// before the guide reassigned it to `container`) restores the ambiguity the
    /// collapse removed, so the count is pinned along with the values.
    func testRadiusScaleHasExactlyThreeSteps() {
        let scale = [IonRadius.control, IonRadius.container, IonRadius.sheet]
        XCTAssertEqual(scale.count, 3)
        XCTAssertEqual(scale, scale.sorted(), "radius roles must stay in ascending order")
        XCTAssertFalse(scale.contains(16), "16pt was deliberately dropped from the radius scale")
    }

    // MARK: - Metrics

    func testMetricsMatchSpecification() {
        XCTAssertEqual(IonSpace.Metric.tabRowHeight, 60)
        XCTAssertEqual(IonSpace.Metric.tabRowVerticalPadding, 10)
        XCTAssertEqual(IonSpace.Metric.standardRowHeight, 44)
        XCTAssertEqual(IonSpace.Metric.sectionHeaderHeight, 28)
        XCTAssertEqual(IonSpace.Metric.sectionHeaderTopPadding, 8)
        XCTAssertEqual(IonSpace.Metric.tabRowLeadingGutter, 16)
        XCTAssertEqual(IonSpace.Metric.tabRowTrailingGutter, 12)
        XCTAssertEqual(IonSpace.Metric.assistantTurnGap, 12)
        XCTAssertEqual(IonSpace.Metric.assistantDocumentGutter, 16)
        XCTAssertEqual(IonSpace.Metric.toolLineInset, 32)
        XCTAssertEqual(IonSpace.Metric.composerBottomOffset, 12)
        XCTAssertEqual(IonSpace.Metric.statusColumnWidth, 8)
        XCTAssertEqual(IonSpace.Metric.compactStatusDiameter, 6)
    }

    /// Both row heights must clear the 44pt touch minimum. A row that drops
    /// below it is unreachable regardless of how good it looks.
    func testRowHeightsClearTheTouchMinimum() {
        XCTAssertGreaterThanOrEqual(IonSpace.Metric.standardRowHeight, 44)
        XCTAssertGreaterThanOrEqual(IonSpace.Metric.tabRowHeight, 44)
    }
}

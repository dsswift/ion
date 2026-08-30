import XCTest
import UIKit
@testable import IonRemote

/// Cartesian chart geometry: two axes, stacking, and annotation routing.
///
/// THE BUG THESE EXIST FOR: iOS DECODED `rightAxis`, a dataset's `axis`,
/// `stacked`, and each annotation's axis, then rendered none of them. Every
/// series was plotted against one shared Swift Charts scale, because a Swift
/// Charts plot has exactly one. A dual-axis chart — a volume in the hundreds
/// beside a rate around 13% — therefore drew the rate flat against the volume
/// domain: not a styling difference, a chart showing no movement in data that
/// moves. The same conversation on the desktop showed both series correctly.
///
/// These assert the pure geometry (`ChartMath`), which is where the axis
/// decisions live, so they fail if the per-axis projection is removed.
final class ChartPlotTests: XCTestCase {

    // MARK: - Fixtures

    /// Volume on the left, rate on the right — the dual-scale shape, with the
    /// two magnitudes deliberately far apart so a shared scale is detectable.
    private func dualAxisSpec() -> ChartSpec {
        decode("""
        {
          "schemaVersion": 1,
          "kind": "bar",
          "title": "Volume and rate",
          "labels": ["Jan", "Feb", "Mar"],
          "datasets": [
            { "label": "Volume", "data": [300, 320, 290], "kind": "bar", "axis": "left" },
            { "label": "Rate", "data": [12.5, 13.1, 11.8], "kind": "line", "axis": "right" }
          ],
          "leftAxis": { "title": "Volume", "format": { "kind": "decimal", "decimals": 0 } },
          "rightAxis": { "title": "Rate", "format": { "kind": "percent", "decimals": 1 } }
        }
        """)
    }

    private func stackedSpec() -> ChartSpec {
        decode("""
        {
          "schemaVersion": 1,
          "kind": "bar",
          "title": "Stacked",
          "labels": ["Jan", "Feb"],
          "datasets": [
            { "label": "A", "data": [10, 20] },
            { "label": "B", "data": [5, null] }
          ],
          "stacked": true
        }
        """)
    }

    private func decode(_ json: String) -> ChartSpec {
        // A fixture that will not decode is a broken test, not a chart the app
        // must survive — that path has its own coverage in ChartSpecTests.
        // swiftlint:disable:next force_try
        try! JSONDecoder().decode(ChartSpec.self, from: Data(json.utf8))
    }

    // MARK: - Axis binding

    func testDatasetsAreSplitByTheAxisTheyDeclare() {
        let spec = dualAxisSpec()
        XCTAssertEqual(ChartMath.datasets(for: .left, in: spec).map(\.label), ["Volume"])
        XCTAssertEqual(ChartMath.datasets(for: .right, in: spec).map(\.label), ["Rate"])
    }

    func testAnAbsentAxisMeansLeft() {
        let spec = stackedSpec()
        XCTAssertEqual(ChartMath.axis(of: spec.datasets[0]), .left)
        XCTAssertEqual(ChartMath.datasets(for: .right, in: spec).count, 0)
    }

    // MARK: - Domains

    func testEachAxisGetsItsOwnDomain() {
        // The exact defect: one shared domain put the rate series at the very
        // bottom of a 0…320 scale, drawing real movement as a flat line.
        let spec = dualAxisSpec()
        let left = ChartMath.domain(for: .left, in: spec)
        let right = ChartMath.domain(for: .right, in: spec)

        // Each axis contains its own data with room to spare, and the two
        // scales are nowhere near each other.
        XCTAssertGreaterThanOrEqual(left.upperBound, 320)
        XCTAssertGreaterThanOrEqual(right.upperBound, 13.1)
        XCTAssertLessThan(right.upperBound, left.upperBound / 10)
    }

    func testARightAxisSeriesUsesTheFullHeightOfItsOwnScale() {
        // Its max must sit near the top of the RIGHT domain, not at 4% of the
        // left one — that ratio is the difference between a readable line and
        // a flat one.
        let spec = dualAxisSpec()
        let right = ChartMath.domain(for: .right, in: spec)
        let top = ChartMath.normalized(13.1, in: right, logarithmic: false)
        XCTAssertGreaterThan(top, 0.5)

        let left = ChartMath.domain(for: .left, in: spec)
        let onLeftScale = ChartMath.normalized(13.1, in: left, logarithmic: false)
        XCTAssertLessThan(onLeftScale, 0.05)
    }

    func testAnExplicitBoundWinsOverTheData() {
        let spec = decode("""
        {
          "schemaVersion": 1, "kind": "line", "title": "Bounded",
          "labels": ["A", "B"],
          "datasets": [{ "label": "S", "data": [10, 20] }],
          "leftAxis": { "min": 0, "max": 100 }
        }
        """)
        let domain = ChartMath.domain(for: .left, in: spec)
        XCTAssertEqual(domain.lowerBound, 0)
        XCTAssertEqual(domain.upperBound, 100)
    }

    func testAnnotationsWidenTheDomainOfTheAxisTheyName() {
        // A target line above every data point must remain visible rather than
        // being clipped off the top of the plot.
        let spec = decode("""
        {
          "schemaVersion": 1, "kind": "line", "title": "Target",
          "labels": ["A", "B"],
          "datasets": [{ "label": "S", "data": [10, 20] }],
          "referenceLines": [{ "value": 90, "label": "Target" }]
        }
        """)
        XCTAssertGreaterThanOrEqual(ChartMath.domain(for: .left, in: spec).upperBound, 90)
    }

    func testAFlatSeriesStillGetsAnExtent() {
        // A zero-height domain would divide by zero and collapse the plot.
        let spec = decode("""
        {
          "schemaVersion": 1, "kind": "line", "title": "Flat",
          "labels": ["A", "B"],
          "datasets": [{ "label": "S", "data": [7, 7] }],
          "leftAxis": { "scale": "linear" }
        }
        """)
        let domain = ChartMath.domain(for: .left, in: spec)
        XCTAssertLessThan(domain.lowerBound, domain.upperBound)
    }

    // MARK: - Zero anchoring, decided per axis

    /// THE BUG THESE PIN: the zero anchor was decided from the CHART kind, so a
    /// stacked bar chart anchored its RIGHT axis to zero as well — even though
    /// the only series there was a line. An 11.2%–14.2% rate was squeezed into
    /// the top fifth of a 0%–14.2% scale and read as almost level, while the
    /// desktop (whose Chart.js scales resolve per scale) drew the same chart
    /// with the line filling the plot. One chart, two shapes.

    /// The exact shape from the reported screenshot: stacked revenue bars on
    /// the left, a conversion-rate line on the right.
    private func stackedBarsWithRateLineSpec() -> ChartSpec {
        decode("""
        {
          "schemaVersion": 1,
          "kind": "bar",
          "title": "Revenue and rate",
          "labels": ["P1", "P2", "P3"],
          "datasets": [
            { "label": "Segment A", "data": [18000, 19500, 21000], "kind": "bar", "axis": "left" },
            { "label": "Segment B", "data": [9200, 10100, null], "kind": "bar", "axis": "left" },
            { "label": "Rate", "data": [11.2, 12.4, 14.2], "kind": "line", "axis": "right" }
          ],
          "leftAxis": { "title": "Revenue" },
          "rightAxis": { "title": "Rate", "format": { "kind": "percent", "decimals": 1 } },
          "stacked": true
        }
        """)
    }

    func testABarAxisAnchorsToZero() {
        // Bar height is read against a zero baseline; without it the shortest
        // bar would render as no bar at all.
        let spec = stackedBarsWithRateLineSpec()
        XCTAssertTrue(ChartMath.axisAnchorsZero(.left, in: spec))
        XCTAssertEqual(ChartMath.domain(for: .left, in: spec).lowerBound, 0)
    }

    func testALineOnlyAxisDoesNotAnchorToZero() {
        // The reported defect. The right axis carries one line, so it ranges
        // near its data — around 11, not down to 0.
        let spec = stackedBarsWithRateLineSpec()
        XCTAssertFalse(ChartMath.axisAnchorsZero(.right, in: spec))
        XCTAssertGreaterThan(ChartMath.domain(for: .right, in: spec).lowerBound, 5)
    }

    func testARateLineKeepsHeadroomInsideItsScale() {
        // THE SECOND REPORTED DEFECT: the axis ended exactly on the data, so
        // the lowest reading sat on the bottom edge and the highest on the top
        // edge. Every series then filled the whole plot height whatever its
        // real spread, and the line ran edge to edge instead of sitting inside
        // the plot the way the desktop draws it.
        let spec = stackedBarsWithRateLineSpec()
        let right = ChartMath.domain(for: .right, in: spec)
        let low = ChartMath.normalized(11.2, in: right, logarithmic: false)
        let high = ChartMath.normalized(14.2, in: right, logarithmic: false)

        XCTAssertGreaterThan(low, 0, "the lowest reading must not sit on the axis floor")
        XCTAssertLessThan(high, 1, "the highest reading must not sit on the axis ceiling")
        // Still uses a real share of the height — headroom must not flatten it.
        XCTAssertGreaterThan(high - low, 0.25)
    }

    func testDataDerivedBoundsLandOnRoundNumbers() {
        // Ending on the data also produced unreadable ticks (3.6%, 10.7%).
        // Nice bounds are what make the labels round.
        let bounds = ChartMath.niceBounds(low: 11.2, high: 14.2)
        XCTAssertEqual(bounds.lowerBound, 11)
        XCTAssertEqual(bounds.upperBound, 15)
    }

    func testNiceBoundsAlwaysContainTheData() {
        // Rounding outward is the invariant: a bound that cut inside the data
        // would clip a real reading off the plot.
        for (low, high) in [(11.2, 14.2), (0.0, 320.0), (-40.0, 85.0), (98.1, 99.4), (0.003, 0.017)] {
            let bounds = ChartMath.niceBounds(low: low, high: high)
            XCTAssertLessThanOrEqual(bounds.lowerBound, low, "low \(low) escaped its domain")
            XCTAssertGreaterThanOrEqual(bounds.upperBound, high, "high \(high) escaped its domain")
        }
    }

    func testAZeroAnchoredAxisStaysAnchoredAfterRounding() {
        // Rounding must not lift a bar axis off zero, or bar heights stop
        // being proportional to their values.
        let spec = stackedBarsWithRateLineSpec()
        XCTAssertEqual(ChartMath.domain(for: .left, in: spec).lowerBound, 0)
    }

    func testAStackedLineSeriesStillAnchorsToZero() {
        // Stacking places a series on the running total of its neighbours,
        // which is measured from zero — so a stacked LINE axis keeps the anchor.
        let spec = decode("""
        {
          "schemaVersion": 1, "kind": "line", "title": "Stacked lines",
          "labels": ["A", "B"],
          "datasets": [
            { "label": "One", "data": [10, 12] },
            { "label": "Two", "data": [5, 6] }
          ],
          "stacked": true
        }
        """)
        XCTAssertTrue(ChartMath.axisAnchorsZero(.left, in: spec))
    }

    func testAFilledAreaAnchorsToZero() {
        // A filled area's shading is read from the baseline.
        let spec = decode("""
        {
          "schemaVersion": 1, "kind": "area", "title": "Filled",
          "labels": ["A", "B"],
          "datasets": [{ "label": "S", "data": [40, 55] }]
        }
        """)
        XCTAssertTrue(ChartMath.axisAnchorsZero(.left, in: spec))
        XCTAssertEqual(ChartMath.domain(for: .left, in: spec).lowerBound, 0)
    }

    func testAPlainLineChartRangesToItsData() {
        let spec = decode("""
        {
          "schemaVersion": 1, "kind": "line", "title": "Levels",
          "labels": ["A", "B"],
          "datasets": [{ "label": "S", "data": [98.1, 99.4] }]
        }
        """)
        XCTAssertFalse(ChartMath.axisAnchorsZero(.left, in: spec))
        // Near its data, not down at zero, and never above the lowest reading.
        let domain = ChartMath.domain(for: .left, in: spec)
        XCTAssertGreaterThan(domain.lowerBound, 90)
        XCTAssertLessThanOrEqual(domain.lowerBound, 98.1)
    }

    func testAnExplicitMinStillWinsOverTheAnchor() {
        // The model stating a scale outranks every inferred rule.
        let spec = decode("""
        {
          "schemaVersion": 1, "kind": "bar", "title": "Bounded bars",
          "labels": ["A", "B"],
          "datasets": [{ "label": "S", "data": [120, 140] }],
          "leftAxis": { "min": 100, "max": 150 }
        }
        """)
        XCTAssertEqual(ChartMath.domain(for: .left, in: spec).lowerBound, 100)
    }

    // MARK: - Stacking

    func testStackingSumsWithinAnAxis() {
        let spec = stackedSpec()
        let second = ChartMath.plottedValues(for: spec.datasets[1], in: spec)
        // B sits on top of A: 5 + 10.
        XCTAssertEqual(second[0], 15)
    }

    func testStackingLeavesTheBaseSeriesUnchanged() {
        let spec = stackedSpec()
        XCTAssertEqual(ChartMath.plottedValues(for: spec.datasets[0], in: spec), [10, 20])
    }

    func testAStackedGapStaysAGap() {
        // A missing reading has no stacked position; drawing it at the running
        // baseline would present the series below it as this one's value.
        let spec = stackedSpec()
        XCTAssertNil(ChartMath.plottedValues(for: spec.datasets[1], in: spec)[1])
    }

    func testStackingNeverCrossesAxes() {
        // Two series on different scales share no baseline, so summing across
        // them would invent a total that means nothing.
        let json = """
        {
          "schemaVersion": 1, "kind": "bar", "title": "Two scales",
          "labels": ["A"],
          "datasets": [
            { "label": "Volume", "data": [300], "axis": "left" },
            { "label": "Rate", "data": [12.5], "axis": "right" }
          ],
          "leftAxis": { "title": "Volume" },
          "rightAxis": { "title": "Rate" },
          "stacked": true
        }
        """
        let spec = decode(json)
        XCTAssertEqual(ChartMath.plottedValues(for: spec.datasets[1], in: spec), [12.5])
    }

    func testUnstackedSeriesAreNotSummed() {
        let spec = decode("""
        {
          "schemaVersion": 1, "kind": "bar", "title": "Grouped",
          "labels": ["A"],
          "datasets": [
            { "label": "One", "data": [10] },
            { "label": "Two", "data": [5] }
          ]
        }
        """)
        XCTAssertEqual(ChartMath.plottedValues(for: spec.datasets[1], in: spec), [5])
    }

    func testCumulativeStillAppliesBeforeStacking() {
        let spec = decode("""
        {
          "schemaVersion": 1, "kind": "bar", "title": "Running total",
          "labels": ["A", "B"],
          "datasets": [{ "label": "S", "data": [10, 5], "cumulative": true }]
        }
        """)
        XCTAssertEqual(ChartMath.plottedValues(for: spec.datasets[0], in: spec), [10, 15])
    }

    // MARK: - Per-axis formatting

    func testEachAxisFormatsItsOwnTicks() {
        // A currency left axis beside a percent right axis is the common
        // dual-scale chart; one shared format would mislabel one of them.
        let spec = dualAxisSpec()
        let left = ChartMath.format(for: .left, in: spec)
        let right = ChartMath.format(for: .right, in: spec)
        XCTAssertEqual(left?.kind, .decimal)
        XCTAssertEqual(right?.kind, .percent)
        XCTAssertTrue(ChartMath.formatted(13.1, right).hasSuffix("%"))
        XCTAssertFalse(ChartMath.formatted(320, left).hasSuffix("%"))
    }

    // MARK: - Scale placement

    func testLogarithmicPlacementIsNotLinear() {
        let domain = 1.0...1000.0
        let mid = ChartMath.normalized(100, in: domain, logarithmic: true)
        // 100 sits two thirds up a decade scale, not a tenth of the way.
        XCTAssertEqual(mid, 2.0 / 3.0, accuracy: 0.0001)
        XCTAssertNotEqual(mid, ChartMath.normalized(100, in: domain, logarithmic: false), accuracy: 0.01)
    }

    func testTicksSpanTheWholeDomain() {
        let ticks = ChartMath.ticks(for: 0.0...100.0, count: 4)
        XCTAssertEqual(ticks.first, 0)
        XCTAssertEqual(ticks.last, 100)
        XCTAssertEqual(ticks.count, 5)
    }

    // MARK: - Wiring

    /// Read as source rather than executed: the seam being protected is "does
    /// a Cartesian spec reach the two-axis renderer", which a SwiftUI view test
    /// cannot assert without a host, and which the source answers directly.
    private func source(_ name: String) -> String {
        let path = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("IonRemote/Views/\(name)")
        return (try? String(contentsOf: path, encoding: .utf8)) ?? ""
    }

    func testCartesianSpecsRouteToTheTwoAxisRenderer() {
        let plot = source("ChartPlotView.swift")
        XCTAssertFalse(plot.isEmpty, "ChartPlotView.swift must be readable")
        XCTAssertTrue(plot.contains("ChartCartesianPlotView(spec: spec)"))
    }

    func testRadialSpecsKeepTheSwiftChartsRenderer() {
        let plot = source("ChartPlotView.swift")
        XCTAssertTrue(plot.contains("SectorMark"), "the radial path must remain Swift Charts")
    }

    func testTheRendererDrawsARightAxisGutter() {
        let cartesian = source("ChartCartesianPlotView.swift")
        XCTAssertFalse(cartesian.isEmpty, "ChartCartesianPlotView.swift must be readable")
        XCTAssertTrue(cartesian.contains("usesRightAxis"))
        XCTAssertTrue(cartesian.contains("tickColumn(axis: .right"))
    }

    // MARK: - Axis gutter
    //
    // THE BUG THESE EXIST FOR: the gutter was a hardcoded 44 points, which fits
    // `14.0%` and does not fit `$40,000`. A currency axis therefore wrapped its
    // top tick onto two lines — the label read `$40,00` above a stray `0`, and
    // the wrapped line collided with the axis title above it.

    /// The tick font the renderer measures with, at the default content size.
    private func tickFont() -> UIFont {
        UIFontMetrics(forTextStyle: IonType.textStyle(.microLabel))
            .scaledFont(for: .systemFont(ofSize: IonType.size(.microLabel), weight: .medium))
    }

    func testACurrencyAxisGetsAWiderGutterThanAPercentAxis() {
        // The real dual-axis case: dollars on the left, a rate on the right.
        // The two gutters must differ, because their labels do.
        let spec = currencyAndRateSpec()
        let font = tickFont()
        let left = ChartMath.axisGutterWidth(for: .left, in: spec, font: font)
        let right = ChartMath.axisGutterWidth(for: .right, in: spec, font: font)
        XCTAssertGreaterThan(left, right, "a $40,000 label is wider than a 15.0% label")
    }

    func testEveryTickLabelFitsInsideItsGutter() {
        // The containment invariant, asserted against the same measurement the
        // renderer places labels with: if a label is wider than its gutter, it
        // wraps on screen. This fails when the gutter is a fixed constant.
        let spec = currencyAndRateSpec()
        let font = tickFont()
        for axis in [ChartAxisId.left, .right] {
            let gutter = ChartMath.axisGutterWidth(for: axis, in: spec, font: font)
            let format = ChartMath.format(for: axis, in: spec)
            for value in ChartMath.ticks(for: ChartMath.domain(for: axis, in: spec)) {
                let label = ChartMath.formatted(value, format)
                let width = (label as NSString).size(withAttributes: [.font: font]).width
                XCTAssertLessThanOrEqual(
                    width, gutter,
                    "\(label) must fit its \(axis) gutter rather than wrap",
                )
            }
        }
    }

    func testTheGutterIsClampedSoOneAxisCannotEatThePlot() {
        let spec = currencyAndRateSpec()
        let font = tickFont()
        let width = ChartMath.axisGutterWidth(
            for: .left, in: spec, font: font, minimum: 30, maximum: 40,
        )
        XCTAssertEqual(width, 40, "an extreme label is clamped, not allowed to squeeze the plot away")
    }

    // MARK: - Decoded fields that must actually render
    //
    // Each of these was decoded by `ChartSpec` and drawn by the desktop, while
    // iOS silently dropped it. A field the model set and no client shows is a
    // chart that answers a question the reader still has.

    func testTheCategoryAxisTitleIsDrawn() {
        let cartesian = source("ChartCartesianPlotView.swift")
        XCTAssertTrue(
            cartesian.contains("spec.categoryAxis?.title"),
            "the category axis names what the labels are",
        )
    }

    func testARangeBandDrawsItsLabel() {
        let cartesian = source("ChartCartesianPlotView.swift")
        XCTAssertTrue(
            cartesian.contains("band.label"),
            "an unnamed band is an unexplained coloured region",
        )
    }

    func testTheLegendHonorsItsSpecPosition() {
        let cartesian = source("ChartCartesianPlotView.swift")
        XCTAssertTrue(
            cartesian.contains("legendPosition"),
            "a Cartesian legend must read spec.legend.position, not assume bottom",
        )
    }

    func testTickLabelsReserveRoomAtBothEndsOfTheAxis() {
        let cartesian = source("ChartCartesianPlotView.swift")
        XCTAssertTrue(
            cartesian.contains("tickOverhang"),
            "a tick label is centred on its tick, so half of the end labels sits outside the plot",
        )
    }

    /// The chart from the render-test conversation: stacked currency bars on
    /// the left, a percent rate line on the right. Used by the gutter tests
    /// because its left labels are the widest an ordinary chart produces.
    private func currencyAndRateSpec() -> ChartSpec {
        decode("""
        {
          "schemaVersion": 1,
          "kind": "bar",
          "title": "Render test",
          "labels": ["P1", "P2", "P3"],
          "stacked": true,
          "datasets": [
            { "label": "Segment A", "data": [18000, 19500, 21000], "kind": "bar", "axis": "left" },
            { "label": "Segment B", "data": [9200, 10100, null], "kind": "bar", "axis": "left" },
            { "label": "Rate", "data": [11.2, 12.4, 14.2], "kind": "line", "axis": "right" }
          ],
          "leftAxis": { "title": "Revenue", "format": { "kind": "currency", "currency": "USD", "decimals": 0 } },
          "rightAxis": { "title": "Rate", "format": { "kind": "percent", "decimals": 1 } }
        }
        """)
    }
}

import XCTest
@testable import IonRemote

/// Behavioral pins for the iOS side of the Ion chart contract.
///
/// The desktop is the producer: `desktop/src/shared/chart-schema.ts` defines
/// the spec and `chartResourceItem` serializes it. These tests decode payloads
/// in exactly that wire shape and assert iOS reads the same numbers the
/// desktop drew, because a chart that renders different values on the two
/// clients is a defect no user can diagnose.
///
/// Fixtures are manufactured: neutral labels, invented numbers.
final class ChartSpecTests: XCTestCase {

    // MARK: - Fixtures

    /// A chart resource payload in the exact shape `chartResourceItem` emits.
    private func payload(
        chartId: String = "chart-1",
        revision: Int = 1,
        specJSON: String,
    ) -> String {
        """
        {
          "chartId": "\(chartId)",
          "title": "Two-series comparison",
          "spec": \(specJSON),
          "revision": \(revision),
          "toolMessageId": "msg-42",
          "createdAt": "2026-01-01T00:00:00Z",
          "updatedAt": "2026-01-02T00:00:00Z"
        }
        """
    }

    private let twoSeriesSpec = """
    {
      "schemaVersion": 1,
      "kind": "line",
      "title": "Two-series comparison",
      "subtitle": "Synthetic values",
      "labels": ["P1", "P2", "P3"],
      "datasets": [
        { "label": "Series A", "data": [10, 20, 30], "color": "#3366ff" },
        { "label": "Series B", "data": [5, null, 15], "axis": "right" }
      ],
      "categoryAxis": { "title": "Period" },
      "leftAxis": { "title": "Units", "format": { "kind": "decimal", "decimals": 0 } },
      "rightAxis": { "title": "Rate", "format": { "kind": "percent", "decimals": 1 } }
    }
    """

    // MARK: - Decoding

    func testDecodesAFullChartPayload() throws {
        let content = try XCTUnwrap(
            ChartResourceContent.decode(from: payload(specJSON: twoSeriesSpec)),
        )
        XCTAssertEqual(content.chartId, "chart-1")
        XCTAssertEqual(content.revision, 1)
        XCTAssertEqual(content.toolMessageId, "msg-42")
        XCTAssertEqual(content.spec.kind, .line)
        XCTAssertEqual(content.spec.labels, ["P1", "P2", "P3"])
        XCTAssertEqual(content.spec.datasets.count, 2)
        XCTAssertEqual(content.spec.categoryAxis?.title, "Period")
    }

    /// A gap must survive decoding AS a gap. If `null` decoded to 0 the chart
    /// would invent a reading the source never had — the one way a chart can
    /// lie while looking perfectly well-formed.
    func testNullStaysAGapAndNeverBecomesZero() throws {
        let content = try XCTUnwrap(
            ChartResourceContent.decode(from: payload(specJSON: twoSeriesSpec)),
        )
        let seriesB = content.spec.datasets[1]
        XCTAssertEqual(seriesB.data.count, 3)
        XCTAssertNil(seriesB.data[1])
        XCTAssertEqual(seriesB.data[0], 5)
        XCTAssertEqual(seriesB.data[2], 15)
    }

    func testMalformedContentDecodesToNilRatherThanThrowing() {
        XCTAssertNil(ChartResourceContent.decode(from: "not json"))
        XCTAssertNil(ChartResourceContent.decode(from: ""))
        XCTAssertNil(ChartResourceContent.decode(from: #"{"chartId":"c1"}"#))
    }

    /// A chart from a newer Ion is refused, not partially drawn.
    func testFutureSchemaVersionIsReportedUnsupported() throws {
        let future = twoSeriesSpec.replacingOccurrences(
            of: "\"schemaVersion\": 1",
            with: "\"schemaVersion\": 99",
        )
        let content = try XCTUnwrap(ChartResourceContent.decode(from: payload(specJSON: future)))
        XCTAssertFalse(content.spec.isSupportedVersion)
    }

    func testRightAxisIsDetectedFromDatasetBinding() throws {
        let content = try XCTUnwrap(
            ChartResourceContent.decode(from: payload(specJSON: twoSeriesSpec)),
        )
        XCTAssertTrue(content.spec.usesRightAxis)
    }

    // MARK: - Cumulative math
    //
    // Mirrors `cumulativeSeries` in chart-schema.ts. The two implementations
    // must agree exactly: the same chart opened on both clients has to show
    // the same running total.

    func testCumulativeCarriesTheTotalAcrossAGap() {
        XCTAssertEqual(
            ChartMath.cumulative([10, 20, nil, 30, 40, 50]).map { $0 ?? -1 },
            [10, 30, -1, 60, 100, 150],
        )
    }

    func testCumulativeStartsFromTheFirstRealValue() {
        XCTAssertEqual(ChartMath.cumulative([nil, 5, 5]).map { $0 ?? -1 }, [-1, 5, 10])
    }

    func testCumulativeHandlesNegativeContributions() {
        XCTAssertEqual(ChartMath.cumulative([10, -4, 2]).map { $0 ?? -1 }, [10, 6, 8])
    }

    /// The transform applies only when the dataset opts in — otherwise the
    /// plotted values are the raw ones.
    func testResolvedDataAppliesCumulativeOnlyWhenRequested() throws {
        let cumulativeSpec = """
        {
          "schemaVersion": 1, "kind": "area", "title": "Running total",
          "labels": ["P1", "P2", "P3"],
          "datasets": [
            { "label": "Running", "data": [10, 20, 30], "cumulative": true },
            { "label": "Raw", "data": [10, 20, 30] }
          ]
        }
        """
        let content = try XCTUnwrap(ChartResourceContent.decode(from: payload(specJSON: cumulativeSpec)))
        XCTAssertEqual(content.spec.datasets[0].resolvedData.map { $0 ?? -1 }, [10, 30, 60])
        XCTAssertEqual(content.spec.datasets[1].resolvedData.map { $0 ?? -1 }, [10, 20, 30])
    }

    // MARK: - Formatting

    func testPercentFormatAppendsTheSign() {
        let format = ChartValueFormat(kind: .percent, decimals: 1, currency: nil)
        XCTAssertEqual(ChartMath.formatted(12.5, format), "12.5%")
    }

    func testCurrencyFormatUsesTheDeclaredCode() {
        let format = ChartValueFormat(kind: .currency, decimals: 0, currency: "USD")
        let rendered = ChartMath.formatted(1500, format)
        XCTAssertTrue(rendered.contains("1,500"), "expected grouped digits, got \(rendered)")
    }

    func testDatasetFormatResolvesThroughItsBoundAxis() throws {
        let content = try XCTUnwrap(
            ChartResourceContent.decode(from: payload(specJSON: twoSeriesSpec)),
        )
        let spec = content.spec
        XCTAssertEqual(ChartMath.format(for: spec.datasets[0], in: spec)?.kind, .decimal)
        XCTAssertEqual(ChartMath.format(for: spec.datasets[1], in: spec)?.kind, .percent)
    }

    // MARK: - Copy payload
    //
    // Copy carries the NUMBERS, not a screenshot: a chart is usually pasted
    // into a message or ticket where a table is useful and an image is not.

    func testPlainTextCarriesEveryValueAndMarksGaps() throws {
        let content = try XCTUnwrap(
            ChartResourceContent.decode(from: payload(specJSON: twoSeriesSpec)),
        )
        let text = ChartMath.plainText(content.spec)
        XCTAssertTrue(text.contains("Two-series comparison"))
        XCTAssertTrue(text.contains("Series A"))
        XCTAssertTrue(text.contains("Series B"))
        XCTAssertTrue(text.contains("P2"))
        // The gap is an em dash, never a zero.
        XCTAssertTrue(text.contains("—"), "a null must copy as a gap marker: \(text)")
    }

    // MARK: - Radial charts

    func testDoughnutDecodesWithExplicitSliceColors() throws {
        let radial = """
        {
          "schemaVersion": 1, "kind": "doughnut", "title": "Composition",
          "labels": ["One", "Two"],
          "datasets": [{ "label": "Share", "data": [60, 40] }],
          "sliceColors": ["#3366ff", "#ff8833"]
        }
        """
        let content = try XCTUnwrap(ChartResourceContent.decode(from: payload(specJSON: radial)))
        XCTAssertTrue(content.spec.kind.isRadial)
        XCTAssertFalse(content.spec.kind.isCartesian)
        XCTAssertEqual(content.spec.sliceColors?.count, 2)
    }

    // MARK: - Annotations

    func testReferenceLinesAndRangeBandsDecode() throws {
        let annotated = """
        {
          "schemaVersion": 1, "kind": "line", "title": "Against target",
          "labels": ["P1", "P2"],
          "datasets": [{ "label": "Actual", "data": [140, 160] }],
          "referenceLines": [{ "value": 150, "label": "Target", "style": "dashed" }],
          "rangeBands": [{ "from": 130, "to": 170, "label": "Expected range" }]
        }
        """
        let content = try XCTUnwrap(ChartResourceContent.decode(from: payload(specJSON: annotated)))
        XCTAssertEqual(content.spec.referenceLines?.first?.value, 150)
        XCTAssertEqual(content.spec.referenceLines?.first?.style, .dashed)
        XCTAssertEqual(content.spec.rangeBands?.first?.from, 130)
        XCTAssertEqual(content.spec.rangeBands?.first?.to, 170)
    }
}

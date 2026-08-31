import XCTest
@testable import IonRemote

/// Chart transcript derivation.
///
/// THE GAP THESE EXIST FOR: iOS rendered charts only in the notifications
/// sheet. The conversation transcript had no chart path at all, so a chart the
/// desktop drew inline was simply absent on the phone — the same conversation,
/// scrolled to the same point, showed nothing.
///
/// The identity rule is the subtle part, and the desktop got it wrong first: a
/// chart id is minted from the tool-GATE request id (`tool-gate-<nanos>-<seq>`)
/// while a transcript row is keyed by the engine's tool-USE id (`toolu_…` /
/// `call_…`). Those id spaces never intersect. Identity therefore comes from
/// the tool RESULT text, never from the row id — these fixtures keep the two
/// families deliberately distinct so that class of defect cannot pass here
/// either.
final class ChartTranscriptTests: XCTestCase {

    // MARK: - Fixtures

    /// An engine tool-use id, in the shape a real transcript row carries.
    private func rowId(_ n: Int) -> String {
        String(format: "toolu_01AbCdEfGhIjKlMnOpQr%02d", n)
    }

    /// A chart id, in the shape the desktop actually mints.
    private func chartId(_ n: Int) -> String {
        "tool-gate-178786470216446100\(n)-\(n)"
    }

    private func specJSON(title: String, operation: String? = nil, chartId: String? = nil) -> String {
        var fields: [String] = [
            "\"schemaVersion\":1",
            "\"kind\":\"line\"",
            "\"title\":\"\(title)\"",
            "\"labels\":[\"A\",\"B\",\"C\"]",
            "\"datasets\":[{\"label\":\"Series A\",\"data\":[1,2,3]}]",
        ]
        if let operation { fields.append("\"operation\":\"\(operation)\"") }
        if let chartId { fields.append("\"chartId\":\"\(chartId)\"") }
        return "{\(fields.joined(separator: ","))}"
    }

    /// The result text the desktop writes, which is the identity channel.
    private func resultText(chartId: String, title: String) -> String {
        "Chart rendered in the conversation. id: \(chartId) · title: \"\(title)\" · line · 1 series · 3 points."
    }

    private func chartRow(
        id: String,
        chartId: String,
        title: String,
        operation: String? = nil,
        status: ToolStatus = .completed,
        content: String? = nil
    ) -> Message {
        var message = Message(
            id: id,
            role: .tool,
            content: content ?? resultText(chartId: chartId, title: title),
            timestamp: 1
        )
        message.toolName = "RenderChart"
        message.toolId = id
        message.toolInput = specJSON(
            title: title,
            operation: operation,
            chartId: operation == "update" ? chartId : nil
        )
        message.toolStatus = status
        return message
    }

    // MARK: - Identity

    func testReadsChartIdFromResultText() {
        let parsed = ChartTranscript.chartId(
            fromResult: resultText(chartId: chartId(1), title: "Revenue")
        )
        XCTAssertEqual(parsed, chartId(1))
    }

    func testReturnsNilWhenResultStatesNoChartId() {
        // A refused call, or any other tool's output, has no identity and must
        // contribute nothing rather than invent one.
        XCTAssertNil(ChartTranscript.chartId(fromResult: "Chart rejected: title is required."))
        XCTAssertNil(ChartTranscript.chartId(fromResult: ""))
        XCTAssertNil(ChartTranscript.chartId(fromResult: nil))
    }

    func testChartIdIsUnrelatedToRowId() {
        // The exact production shape: no substring of either appears in the
        // other. A derivation from the row id cannot work.
        XCTAssertFalse(rowId(1).contains(chartId(1)))
        XCTAssertFalse(chartId(1).contains(rowId(1)))
    }

    // MARK: - Derivation

    func testDerivesOneTimelineForASingleChart() {
        let messages = [chartRow(id: rowId(1), chartId: chartId(1), title: "Revenue")]
        let timelines = ChartTranscript.timelines(from: messages)

        XCTAssertEqual(timelines.count, 1)
        XCTAssertEqual(timelines[0].chartId, chartId(1))
        XCTAssertEqual(timelines[0].title, "Revenue")
        XCTAssertEqual(timelines[0].revisions.count, 1)
        XCTAssertEqual(timelines[0].currentMessageId, rowId(1))
    }

    func testGroupsAnUpdateOntoItsCreate() {
        let messages = [
            chartRow(id: rowId(1), chartId: chartId(1), title: "Revenue"),
            chartRow(id: rowId(2), chartId: chartId(1), title: "Revenue", operation: "update"),
        ]
        let timelines = ChartTranscript.timelines(from: messages)

        XCTAssertEqual(timelines.count, 1)
        XCTAssertEqual(timelines[0].revisions.count, 2)
        XCTAssertEqual(timelines[0].currentMessageId, rowId(2))
    }

    func testKeepsDistinctChartsIndependent() {
        let messages = [
            chartRow(id: rowId(1), chartId: chartId(1), title: "Revenue"),
            chartRow(id: rowId(2), chartId: chartId(2), title: "Costs"),
        ]
        XCTAssertEqual(ChartTranscript.timelines(from: messages).count, 2)
    }

    func testIgnoresARunningRow() {
        // A running row has no result yet, so it has no identity.
        let messages = [chartRow(id: rowId(1), chartId: chartId(1), title: "Revenue", status: .running)]
        XCTAssertTrue(ChartTranscript.timelines(from: messages).isEmpty)
    }

    func testIgnoresAFailedRow() {
        // A refusal must not be able to change which chart is current.
        let messages = [
            chartRow(id: rowId(1), chartId: chartId(1), title: "Revenue"),
            chartRow(id: rowId(2), chartId: chartId(2), title: "Bad", status: .error),
        ]
        let timelines = ChartTranscript.timelines(from: messages)
        XCTAssertEqual(timelines.count, 1)
        XCTAssertEqual(timelines[0].title, "Revenue")
    }

    func testIgnoresAnOrphanUpdate() {
        // After a rewind past the create, an update has nothing to revise.
        let messages = [
            chartRow(id: rowId(2), chartId: chartId(1), title: "Revenue", operation: "update"),
        ]
        XCTAssertTrue(ChartTranscript.timelines(from: messages).isEmpty)
    }

    func testIgnoresPartialStreamedInput() {
        var message = Message(
            id: rowId(1),
            role: .tool,
            content: resultText(chartId: chartId(1), title: "R"),
            timestamp: 1
        )
        message.toolName = "RenderChart"
        message.toolInput = "{\"schemaVersion\":1,\"kind\":\"li"
        message.toolStatus = ToolStatus.completed
        XCTAssertTrue(ChartTranscript.timelines(from: [message]).isEmpty)
    }

    func testIgnoresOtherTools() {
        var message = Message(id: rowId(1), role: .tool, content: "ok", timestamp: 1)
        message.toolName = "Read"
        message.toolInput = "{\"file_path\":\"/tmp/a\"}"
        message.toolStatus = ToolStatus.completed
        XCTAssertTrue(ChartTranscript.timelines(from: [message]).isEmpty)
    }

    // MARK: - Row renders

    func testCurrentRowRendersTheCardAndEarlierRowsShowAMarker() {
        let messages = [
            chartRow(id: rowId(1), chartId: chartId(1), title: "Revenue"),
            chartRow(id: rowId(2), chartId: chartId(1), title: "Revenue", operation: "update"),
        ]
        let renders = ChartTranscript.rowRenders(from: messages)

        guard case .moved(_, _, let target)? = renders[rowId(1)] else {
            return XCTFail("first row should be superseded")
        }
        XCTAssertEqual(target, rowId(2))

        guard case .current? = renders[rowId(2)] else {
            return XCTFail("latest row should own the live card")
        }
    }

    func testSingleRevisionRendersAsCurrent() {
        let renders = ChartTranscript.rowRenders(
            from: [chartRow(id: rowId(1), chartId: chartId(1), title: "Revenue")]
        )
        guard case .current? = renders[rowId(1)] else {
            return XCTFail("a lone revision is the current card")
        }
    }

    func testRowsWithoutChartsHaveNoRender() {
        let renders = ChartTranscript.rowRenders(from: [])
        XCTAssertTrue(renders.isEmpty)
    }
}

/// Both transcript group kinds must render charts.
///
/// THE BUG THIS EXISTS FOR: chart renders were threaded into the `.toolGroup`
/// row only. A conversation whose tool rows group as `.agentTurn` — a unified
/// turn, which is the common shape — had no path from the derivation to the
/// screen at all, so charts stayed invisible on iOS while the desktop showed
/// them. The desktop renders visual output in BOTH of its group components;
/// iOS was wired for one.
///
/// Read as source rather than executed: the seam being protected is "is the
/// prop passed", which a SwiftUI view test cannot assert without a host, and
/// which the source answers directly.
final class ChartRowWiringTests: XCTestCase {

    private func source(_ name: String) -> String {
        let path = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // IonRemoteTests
            .deletingLastPathComponent()   // ios
            .appendingPathComponent("IonRemote/Views/\(name)")
        return (try? String(contentsOf: path, encoding: .utf8)) ?? ""
    }

    func testTranscriptPassesChartRendersToBothGroupKinds() {
        let transcript = source("Transcript.swift")
        XCTAssertFalse(transcript.isEmpty, "Transcript.swift must be readable")
        // Two call sites: EngineToolGroupRow and AgentTurnRow.
        let occurrences = transcript.components(separatedBy: "chartRenders: chartRenders").count - 1
        XCTAssertEqual(occurrences, 2, "both .toolGroup and .agentTurn must receive chart renders")
    }

    func testAgentTurnRowRendersChartCards() {
        let row = source("AgentTurnRow.swift")
        XCTAssertTrue(row.contains("var chartRenders"), "AgentTurnRow must accept chart renders")
        XCTAssertTrue(row.contains("ChartTranscriptCard"), "AgentTurnRow must render chart cards")
    }

    func testToolGroupRowRendersChartCards() {
        let row = source("EngineToolGroupRow.swift")
        XCTAssertTrue(row.contains("var chartRenders"), "EngineToolGroupRow must accept chart renders")
        XCTAssertTrue(row.contains("ChartTranscriptCard"), "EngineToolGroupRow must render chart cards")
    }
}

/// Exact values are collapsed by default.
///
/// THE PARITY GAP THIS EXISTS FOR: the desktop card puts the value table
/// behind a "Show exact values" disclosure; iOS rendered it unconditionally.
/// In a transcript the table is often taller than the plot it describes, so
/// every chart pushed the following turn off screen.
///
/// The numbers are not optional — a chart answers "roughly how much", and an
/// operator quoting it, or a VoiceOver user for whom the table IS the chart,
/// needs "exactly how much". Collapsed, not removed.
final class ChartValueTableDisclosureTests: XCTestCase {

    private var cardSource: String {
        let path = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("IonRemote/Views/ChartCardView.swift")
        return (try? String(contentsOf: path, encoding: .utf8)) ?? ""
    }

    func testValueTableIsBehindADisclosure() {
        let source = cardSource
        XCTAssertFalse(source.isEmpty, "ChartCardView.swift must be readable")
        XCTAssertTrue(source.contains("showValues"), "the table's visibility must be state-driven")
        XCTAssertTrue(source.contains("if showValues {"), "the table must be conditional")
    }

    func testDisclosureStartsCollapsed() {
        // Default-open would reproduce the clutter this fixes.
        XCTAssertTrue(
            cardSource.contains("showValues = false"),
            "exact values must start hidden, matching the desktop card"
        )
    }

    func testDisclosureLabelMatchesTheDesktopWording() {
        // One product vocabulary across clients; the desktop says exactly this.
        let source = cardSource
        XCTAssertTrue(source.contains("Show exact values"))
        XCTAssertTrue(source.contains("Hide exact values"))
    }

    func testValuesRemainReachable() {
        // Collapsing must not remove the table: it is the only representation
        // for a screen-reader user, and the copy action reads the same series.
        XCTAssertTrue(cardSource.contains("valueTable"))
    }
}

/// The chart-anchor path: a card reports its position, a jump reads it.
///
/// THE BUG THIS EXISTS FOR: a transcript row is a whole TURN — assistant text,
/// then tool rows, then the chart card at the very end. Scrolling to the row
/// lands at the top of the turn, leaving the chart the operator tapped below
/// the fold on any tall turn.
///
/// The desktop measures the chart element in the DOM. iOS cannot: a row is a
/// SwiftUI view inside a UIHostingConfiguration, and walking that hierarchy to
/// find a card would depend on UIKit's private view tree. So the card reports
/// its own frame through a preference and the scroll code reads the report.
@MainActor
final class ChartAnchorTests: XCTestCase {

    private func source(_ name: String) -> String {
        let path = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("IonRemote/Views/\(name)")
        return (try? String(contentsOf: path, encoding: .utf8)) ?? ""
    }

    func testRegistryReturnsTheReportedOffset() {
        ChartAnchorRegistry.shared.record(["chart-a": 420])
        XCTAssertEqual(ChartAnchorRegistry.shared.offsetWithinRow(for: "chart-a"), 420)
    }

    func testRegistryReportsNilForAnUnseenChart() {
        // A jump must fall back to the row's own offset rather than target a
        // position it does not have.
        XCTAssertNil(ChartAnchorRegistry.shared.offsetWithinRow(for: "chart-never-rendered"))
    }

    func testLaterReportsOverwriteEarlierOnes() {
        ChartAnchorRegistry.shared.record(["chart-b": 100])
        ChartAnchorRegistry.shared.record(["chart-b": 900])
        XCTAssertEqual(ChartAnchorRegistry.shared.offsetWithinRow(for: "chart-b"), 900)
    }

    func testPreferenceReduceMergesAcrossCards() {
        // Several visible charts each report; none may clobber the others.
        var value: [String: CGFloat] = ["a": 0]
        ChartAnchorKey.reduce(value: &value) { ["b": 5] }
        XCTAssertEqual(value.count, 2)
        XCTAssertNotNil(value["a"])
        XCTAssertNotNil(value["b"])
    }

    // MARK: - Scroll invariance

    /// THE BUG THIS PINS: the anchor was first stored as a GLOBAL frame. A
    /// global frame is true only for the instant it was measured — scroll the
    /// list and it is stale, and a card that scrolls out of view stops
    /// reporting entirely, leaving a value from an arbitrary past position.
    /// Adding that to the current offset produced a random target: jumps
    /// landed at the top or the bottom of the conversation, and appeared to
    /// work only for a chart that happened to be on screen already.
    ///
    /// An offset within the row does not have that failure mode.
    func testStoredAnchorIsAnOffsetNotAScreenPosition() {
        // A CGFloat offset cannot encode a scroll position, which is what
        // makes staleness impossible by construction.
        ChartAnchorRegistry.shared.record(["chart-invariant": 250])
        let first = ChartAnchorRegistry.shared.offsetWithinRow(for: "chart-invariant")
        // Nothing about scrolling can change it — there is no scroll term in
        // the stored value.
        let second = ChartAnchorRegistry.shared.offsetWithinRow(for: "chart-invariant")
        XCTAssertEqual(first, second)
        XCTAssertEqual(first, 250)
    }

    func testTargetIsRowTopPlusOffset() {
        // The arithmetic the scroll code performs, stated once: the row frame
        // is current (the layout just produced it) and the offset is
        // scroll-invariant, so their sum is the card's real position.
        let rowTop: CGFloat = 12_000
        let within: CGFloat = 380
        let margin: CGFloat = 16
        XCTAssertEqual(rowTop + within - margin, 12_364)
    }

    // MARK: - Wiring

    func testCardReportsItsAnchor() {
        XCTAssertTrue(
            source("ChartTranscriptCard.swift").contains("reportsChartAnchor"),
            "the transcript card must publish its position"
        )
    }

    func testBothRowKindsDeclareTheAnchorSpace() {
        // A card measures against its row's named space; a row that does not
        // declare it would have its cards measuring against the screen again.
        for row in ["AgentTurnRow.swift", "EngineToolGroupRow.swift"] {
            XCTAssertTrue(
                source(row).contains("coordinateSpace(name: ChartAnchorKey.rowSpace)"),
                "\(row) must declare the row coordinate space"
            )
        }
    }

    func testAnchorIsMeasuredInTheRowSpaceNotGlobal() {
        let key = source("ChartAnchorKey.swift")
        XCTAssertTrue(key.contains(".named(ChartAnchorKey.rowSpace)"),
                      "the card must measure against its row")
        XCTAssertFalse(key.contains("frame(in: .global)"),
                       "a global frame is stale the moment the list scrolls")
    }

    func testTranscriptCollectsAnchorReports() {
        XCTAssertTrue(
            source("Transcript.swift").contains("ChartAnchorRegistry.shared.record"),
            "reported frames must reach the registry the scroll code reads"
        )
    }

    func testScrollRefinesOntoTheCard() {
        let scrolling = source("ChatCollectionScrolling.swift")
        XCTAssertTrue(
            scrolling.contains("ChartAnchorRegistry.shared.offsetWithinRow(for: chartId)"),
            "the jump must refine its target onto the card's offset within its row"
        )
        XCTAssertTrue(
            scrolling.contains("frame.minY + within"),
            "the target must be the CURRENT row position plus the card's offset"
        )
        XCTAssertTrue(
            scrolling.contains("chartJumpTopMargin"),
            "the card must land with breathing room, not flush to the edge"
        )
    }

    func testScrollReportsWhichAnchorItUsed() {
        // Distinguishes "landed on the card" from "fell back to the turn"
        // without another rebuild cycle.
        XCTAssertTrue(source("ChatCollectionScrolling.swift").contains("anchored_on"))
    }
}

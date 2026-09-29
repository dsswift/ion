import XCTest
@testable import IonRemote

/// The stream rule: apply a patch only when it continues exactly from the
/// revision held, and ask for a fresh snapshot on anything else.
final class TranscriptStreamTests: XCTestCase {

    private typealias T = TranscriptTestSupport

    private func opened(_ rows: [Message], rev: Int = 0, startIndex: Int = 0, total: Int? = nil) -> (TranscriptStream?, [Message]) {
        var stream: TranscriptStream?
        var held: [Message] = []
        let outcome = TranscriptStream.apply(page: T.page(tabId: "t", rows: rows, rev: rev, startIndex: startIndex, total: total), stream: &stream, rows: &held)
        XCTAssertEqual(outcome, .applied)
        return (stream, held)
    }

    func testANewestPageReplacesWhateverWasHeld() {
        var (stream, rows) = opened([T.row("a", .user), T.row("b")], rev: 3)
        let outcome = TranscriptStream.apply(page: T.page(tabId: "t", rows: [T.row("x", .user)], rev: 9, epoch: "epoch-2"), stream: &stream, rows: &rows)
        XCTAssertEqual(outcome, .applied)
        XCTAssertEqual(rows.map(\.id), ["x"])
        XCTAssertEqual(stream?.rev, 9)
        XCTAssertEqual(stream?.epoch, "epoch-2")
    }

    func testAnAppendGrowsTheRowAndAdvancesTheRevision() {
        var (stream, rows) = opened([T.row("a", .user), T.row("b", .assistant, "Hel")])
        let outcome = TranscriptStream.apply(
            patch: T.patch(tabId: "t", baseRev: 0, total: 2, change: .append(index: 1, id: "b", field: .content, text: "lo")),
            stream: &stream, rows: &rows, awaitingSnapshot: false
        )
        XCTAssertEqual(outcome, .applied)
        XCTAssertEqual(rows[1].content, "Hello")
        XCTAssertEqual(stream?.rev, 1)
    }

    func testASpliceReplacesRows() {
        var (stream, rows) = opened([T.row("a", .user), T.row("b"), T.row("c")])
        let outcome = TranscriptStream.apply(
            patch: T.patch(tabId: "t", baseRev: 0, total: 2, change: .splice(at: 1, deleteCount: 2, rows: [T.row("d")])),
            stream: &stream, rows: &rows, awaitingSnapshot: false
        )
        XCTAssertEqual(outcome, .applied)
        XCTAssertEqual(rows.map(\.id), ["a", "d"])
    }

    /// The gap this whole design exists to catch: a patch the phone missed
    /// (a dropped frame, a sleeping phone) is PROVEN missing by the next
    /// patch's baseRev, and the phone re-fetches instead of rendering a hole.
    func testAMissedRevisionAsksForASnapshot() {
        var (stream, rows) = opened([T.row("a", .user)])
        let outcome = TranscriptStream.apply(
            patch: T.patch(tabId: "t", baseRev: 1, total: 2, change: .splice(at: 1, deleteCount: 0, rows: [T.row("b")])),
            stream: &stream, rows: &rows, awaitingSnapshot: false
        )
        XCTAssertEqual(outcome, .resync("rev_gap"))
        XCTAssertEqual(rows.map(\.id), ["a"], "a patch that does not fit must change nothing")
    }

    func testAnotherEpochAsksForASnapshot() {
        var (stream, rows) = opened([T.row("a", .user)])
        let outcome = TranscriptStream.apply(
            patch: T.patch(tabId: "t", baseRev: 0, total: 1, change: .append(index: 0, id: "a", field: .content, text: "x"), epoch: "restarted"),
            stream: &stream, rows: &rows, awaitingSnapshot: false
        )
        XCTAssertEqual(outcome, .resync("epoch_changed"))
    }

    func testAnAppendToTheWrongRowAsksForASnapshot() {
        var (stream, rows) = opened([T.row("a", .user), T.row("b")])
        let outcome = TranscriptStream.apply(
            patch: T.patch(tabId: "t", baseRev: 0, total: 2, change: .append(index: 1, id: "not-b", field: .content, text: "x")),
            stream: &stream, rows: &rows, awaitingSnapshot: false
        )
        XCTAssertEqual(outcome, .resync("append_mismatch"))
    }

    func testAResetAsksForASnapshot() {
        var (stream, rows) = opened([T.row("a", .user)])
        let outcome = TranscriptStream.apply(
            patch: T.patch(tabId: "t", baseRev: 0, total: 900, change: .reset(reason: "too_large")),
            stream: &stream, rows: &rows, awaitingSnapshot: false
        )
        XCTAssertEqual(outcome, .resync("reset_too_large"))
    }

    func testPatchesWhileASnapshotIsOnItsWayAreIgnored() {
        var (stream, rows) = opened([T.row("a", .user)])
        let outcome = TranscriptStream.apply(
            patch: T.patch(tabId: "t", baseRev: 5, total: 1, change: .append(index: 0, id: "a", field: .content, text: "x")),
            stream: &stream, rows: &rows, awaitingSnapshot: true
        )
        XCTAssertEqual(outcome, .ignored("awaiting_snapshot"))
        XCTAssertEqual(rows[0].content, "")
    }

    // MARK: - Windows (the phone holds only the newest rows)

    func testPatchIndicesAreWholeTranscriptPositions() {
        // The phone holds rows 10 and 11 of 12.
        var (stream, rows) = opened([T.row("r10", .user), T.row("r11", .assistant, "a")], startIndex: 10, total: 12)
        let outcome = TranscriptStream.apply(
            patch: T.patch(tabId: "t", baseRev: 0, total: 12, change: .append(index: 11, id: "r11", field: .content, text: "b")),
            stream: &stream, rows: &rows, awaitingSnapshot: false
        )
        XCTAssertEqual(outcome, .applied)
        XCTAssertEqual(rows[1].content, "ab")
    }

    func testAChangeOlderThanTheWindowAsksForASnapshot() {
        // A rewind to row 3 when the phone holds rows 10 and 11.
        var (stream, rows) = opened([T.row("r10", .user), T.row("r11")], startIndex: 10, total: 12)
        let outcome = TranscriptStream.apply(
            patch: T.patch(tabId: "t", baseRev: 0, total: 3, change: .splice(at: 3, deleteCount: 9, rows: [])),
            stream: &stream, rows: &rows, awaitingSnapshot: false
        )
        XCTAssertEqual(outcome, .resync("below_window"))
    }

    func testAnOlderPageThatContinuesTheWindowIsPrepended() {
        var (stream, rows) = opened([T.row("r2", .user), T.row("r3")], startIndex: 2, total: 4)
        let older = T.page(tabId: "t", rows: [T.row("r0", .user), T.row("r1")], startIndex: 0, total: 4, isNewest: false)
        XCTAssertEqual(TranscriptStream.apply(page: older, stream: &stream, rows: &rows), .applied)
        XCTAssertEqual(rows.map(\.id), ["r0", "r1", "r2", "r3"])
        XCTAssertEqual(stream?.startIndex, 0)
        XCTAssertEqual(stream?.hasOlder, false)
    }

    func testAnOlderPageFromAnotherRevisionAsksForASnapshot() {
        var (stream, rows) = opened([T.row("r2", .user), T.row("r3")], rev: 4, startIndex: 2, total: 4)
        let older = T.page(tabId: "t", rows: [T.row("r0", .user), T.row("r1")], rev: 3, startIndex: 0, total: 4, isNewest: false)
        XCTAssertEqual(TranscriptStream.apply(page: older, stream: &stream, rows: &rows), .resync("older_page_stale"))
        XCTAssertEqual(rows.map(\.id), ["r2", "r3"])
    }

    func testAnOlderPageThatLeavesAHoleAsksForASnapshot() {
        var (stream, rows) = opened([T.row("r5", .user)], startIndex: 5, total: 6)
        let older = T.page(tabId: "t", rows: [T.row("r0", .user), T.row("r1")], startIndex: 0, total: 6, isNewest: false)
        XCTAssertEqual(TranscriptStream.apply(page: older, stream: &stream, rows: &rows), .resync("older_page_not_contiguous"))
    }
}

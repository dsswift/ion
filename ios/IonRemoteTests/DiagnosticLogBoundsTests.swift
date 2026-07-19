import XCTest
@testable import IonRemote

/// Pins the DiagnosticLog memory bounds: the 4KB per-message cap (jetsam
/// amplifier fix) and the incremental-export byte cursor (main-thread
/// full-rescan fix).
final class DiagnosticLogBoundsTests: XCTestCase {

    override func setUp() {
        super.setUp()
        DiagnosticLog.minLevel = .trace
    }

    override func tearDown() {
        DiagnosticLog.minLevel = .info
        super.tearDown()
    }

    // MARK: - Test 3: message cap

    /// A 1MB message must be stored and exported capped at maxMessageBytes
    /// with the truncation marker. Red on unfixed code: Entry stored the full
    /// megabyte in the ring buffer AND in every exported line.
    func testHugeMessageCappedInRingBufferAndExport() throws {
        let huge = String(repeating: "z", count: 1_000_000)
        DiagnosticLog.log(huge, tag: "bounds", level: .info)
        DiagnosticLog.flush()

        // In-memory ring buffer entry is capped.
        let entry = DiagnosticLog.entries().last
        XCTAssertNotNil(entry)
        let stored = entry!.message
        XCTAssertLessThanOrEqual(
            stored.utf8.count,
            DiagnosticLog.maxMessageBytes + DiagnosticLog.truncationMarker.utf8.count,
            "ring-buffer message must be capped at maxMessageBytes (+ marker)"
        )
        XCTAssertTrue(stored.hasSuffix(DiagnosticLog.truncationMarker),
                      "capped message must end with the truncation marker")

        // Exported JSONL line is capped too (the same bounded Entry feeds both).
        let raw = DiagnosticLog.exportCurrentSession()
        let lines = raw.components(separatedBy: "\n").filter { !$0.isEmpty }
        let last = try XCTUnwrap(lines.last)
        XCTAssertLessThan(last.utf8.count, 100_000,
                          "exported line must not carry the megabyte payload")
        let obj = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(last.utf8)) as? [String: Any])
        let msg = try XCTUnwrap(obj["msg"] as? String)
        XCTAssertTrue(msg.hasSuffix(DiagnosticLog.truncationMarker))
        XCTAssertLessThanOrEqual(
            msg.utf8.count,
            DiagnosticLog.maxMessageBytes + DiagnosticLog.truncationMarker.utf8.count)
    }

    /// Sub-cap messages pass through untouched — no marker, no truncation.
    func testSmallMessageNotTruncated() {
        let msg = "a perfectly normal log message"
        XCTAssertEqual(DiagnosticLog.boundedMessage(msg), msg)
    }

    /// Cap cuts on a character boundary even with multi-byte characters.
    func testBoundedMessageMultibyteSafety() {
        let huge = String(repeating: "é", count: 10_000) // 2 bytes each
        let bounded = DiagnosticLog.boundedMessage(huge)
        XCTAssertLessThanOrEqual(
            bounded.utf8.count,
            DiagnosticLog.maxMessageBytes + DiagnosticLog.truncationMarker.utf8.count)
        XCTAssertTrue(bounded.hasSuffix(DiagnosticLog.truncationMarker))
    }

    // MARK: - Test 4: export cursor

    /// Export, write more, export again → the second pull returns only the
    /// new lines (cursor semantics), and a rotated-in session file with no
    /// cursor entry is still exported in full (read from 0).
    func testExportCursorIncrementalAndRotation() async throws {
        DiagnosticLog.log("cursor line 1", tag: "cursor", level: .info)
        DiagnosticLog.flush()

        let first = await DiagnosticLog.exportIncrementalSince(sinceSeq: 0)
        XCTAssertFalse(first.logs.isEmpty)

        // Write more; second pull returns ONLY the new lines.
        DiagnosticLog.log("cursor line 2", tag: "cursor", level: .info)
        DiagnosticLog.log("cursor line 3", tag: "cursor", level: .info)
        DiagnosticLog.flush()
        let second = await DiagnosticLog.exportIncrementalSince(sinceSeq: first.nextSeq)
        let secondLines = second.logs.components(separatedBy: "\n").filter { !$0.isEmpty }
        XCTAssertEqual(secondLines.count, 2, "only the two new lines must ship")
        XCTAssertTrue(second.logs.contains("cursor line 2"))
        XCTAssertTrue(second.logs.contains("cursor line 3"))
        XCTAssertFalse(second.logs.contains("cursor line 1"),
                       "already-pulled lines must not re-ship")

        // Rotation: drop a new session file (no cursor entry) with a line
        // whose seq is newer than everything pulled so far. The export must
        // read it from offset 0 and include it.
        let rotatedSeq = second.nextSeq + 1_000
        let rotatedLine = #"{"ts":"2026-01-01T00:00:00.000Z","level":"INFO","component":"ios","tag":"cursor","msg":"rotated line","fields":{"seq":"\#(rotatedSeq)"}}"# + "\n"
        let rotatedURL = DiagnosticLog.shared.logDirectory
            .appendingPathComponent("session-2026-01-01T00-00-00Z-cursor-test.log")
        try rotatedLine.data(using: .utf8)!.write(to: rotatedURL)
        defer { try? FileManager.default.removeItem(at: rotatedURL) }

        let third = await DiagnosticLog.exportIncrementalSince(sinceSeq: second.nextSeq)
        XCTAssertTrue(third.logs.contains("rotated line"),
                      "a rotated-in file with no cursor entry must be exported from offset 0")
        // nextSeq is the highest seq shipped (the resume cursor), not max+1 —
        // max+1 would make the strict-greater filter and the desktop dedup
        // both skip the next written line (off-by-one, fixed with the cursor).
        XCTAssertEqual(third.nextSeq, rotatedSeq)
    }

    /// A pull older than what the cursor already skipped resets the cursor
    /// and rescans — no line older than the cursor is ever silently dropped.
    func testExportCursorResetOnOlderSinceSeq() async throws {
        DiagnosticLog.log("reset probe", tag: "cursor", level: .info)
        DiagnosticLog.flush()
        let advanced = await DiagnosticLog.exportIncrementalSince(sinceSeq: 0)
        XCTAssertFalse(advanced.logs.isEmpty)

        // Re-pull from 0 (desktop lost its mark). Everything must re-ship.
        let repull = await DiagnosticLog.exportIncrementalSince(sinceSeq: 0)
        XCTAssertTrue(repull.logs.contains("reset probe"),
                      "sinceSeq below the scanned max must reset the cursor and rescan")
    }
}

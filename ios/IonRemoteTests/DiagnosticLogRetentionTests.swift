import XCTest
@testable import IonRemote

/// Pins that the on-device log never loses a line the server has not received:
///   - retention deletes only segments every paired server has confirmed,
///     until the hard cap
///   - a pull spanning a mid-session rotation returns every line exactly once
///   - the server's `sinceSeq` is recorded as its confirmation
///   - a `sinceSeq` from an older seq space ships from 0 instead of nothing
final class DiagnosticLogRetentionTests: XCTestCase {

    private var savedSegmentMaxBytes: UInt64 = 0
    private var savedKnown: Any?
    private var savedMarks: Any?

    override func setUp() {
        super.setUp()
        DiagnosticLog.minLevel = .trace
        savedSegmentMaxBytes = DiagnosticLog.segmentMaxBytes
        DiagnosticLog.flush()
        savedKnown = UserDefaults.standard.object(forKey: DiagnosticLog.knownPairingsDefaultsKey)
        savedMarks = UserDefaults.standard.object(forKey: DiagnosticLog.shippedMarksDefaultsKey)
    }

    override func tearDown() {
        DiagnosticLog.segmentMaxBytes = savedSegmentMaxBytes
        DiagnosticLog.setPairingId(nil)
        DiagnosticLog.flush()
        UserDefaults.standard.set(savedKnown, forKey: DiagnosticLog.knownPairingsDefaultsKey)
        UserDefaults.standard.set(savedMarks, forKey: DiagnosticLog.shippedMarksDefaultsKey)
        DiagnosticLog.minLevel = .info
        super.tearDown()
    }

    // MARK: - Retention policy

    private func segment(_ name: String, mb: UInt64, maxSeq: Int, _ pairings: [String: Int]) -> DiagnosticLog.RetainedSegment {
        DiagnosticLog.RetainedSegment(
            name: name,
            bytes: mb * 1_048_576,
            summary: DiagnosticLog.SegmentSummary(maxSeq: maxSeq, pairingMaxSeq: pairings)
        )
    }

    private func plan(
        _ segments: [DiagnosticLog.RetainedSegment],
        shipped: [String: Int],
        known: Set<String>? = ["A", "B"],
        budgetMB: UInt64 = 3,
        capMB: UInt64 = 6
    ) -> [DiagnosticLog.RetentionDrop] {
        DiagnosticLog.retentionPlan(
            segments: segments,
            currentBytes: 0,
            shippedThrough: shipped,
            knownPairings: known,
            shippedBudget: budgetMB * 1_048_576,
            hardCap: capMB * 1_048_576
        )
    }

    func testUnconfirmedSegmentsSurvivePastTheShippedBudget() {
        let segments = [
            segment("s1", mb: 2, maxSeq: 10, ["A": 10]),
            segment("s2", mb: 2, maxSeq: 20, ["A": 20]),
        ]
        XCTAssertEqual(plan(segments, shipped: ["A": 9]), [],
                       "4 MB is over the 3 MB budget, but A has not confirmed either segment")
    }

    func testConfirmedSegmentsGoOldestFirstDownToTheBudget() {
        let segments = [
            segment("s1", mb: 2, maxSeq: 10, ["A": 10]),
            segment("s2", mb: 2, maxSeq: 20, ["A": 20]),
            segment("s3", mb: 2, maxSeq: 30, ["A": 30]),
        ]
        let drops = plan(segments, shipped: ["A": 30], capMB: 100)
        XCTAssertEqual(drops.map(\.segment.name), ["s1", "s2"])
        XCTAssertTrue(drops.allSatisfy { $0.unshippedPairings.isEmpty })
    }

    func testASegmentWaitsForEveryPairingInIt() {
        let segments = [
            segment("s1", mb: 2, maxSeq: 10, ["A": 9, "B": 10]),
            segment("s2", mb: 2, maxSeq: 20, ["A": 20]),
        ]
        let drops = plan(segments, shipped: ["A": 20, "B": 5], capMB: 100)
        XCTAssertEqual(drops.map(\.segment.name), ["s2"],
                       "B has not confirmed s1, so the newer confirmed s2 goes instead")
    }

    func testLinesForAnUnpairedServerAndUnstampedLinesHoldNothing() {
        let segments = [
            segment("s1", mb: 2, maxSeq: 10, ["gone": 10]),
            segment("s2", mb: 2, maxSeq: 20, [:]),
        ]
        XCTAssertEqual(plan(segments, shipped: [:]).map(\.segment.name), ["s1"])
    }

    func testAnUnknownPairingListKeepsEveryPairingsLines() {
        let segments = [
            segment("s1", mb: 2, maxSeq: 10, ["gone": 10]),
            segment("s2", mb: 2, maxSeq: 20, ["gone": 20]),
        ]
        XCTAssertEqual(plan(segments, shipped: [:], known: nil), [])
    }

    func testTheHardCapDropsUnconfirmedSegmentsOldestFirstAndNamesThem() {
        let segments = [
            segment("s1", mb: 3, maxSeq: 10, ["A": 10]),
            segment("s2", mb: 3, maxSeq: 20, ["B": 20]),
            segment("s3", mb: 3, maxSeq: 30, ["A": 30]),
        ]
        let drops = plan(segments, shipped: [:])
        XCTAssertEqual(drops.map(\.segment.name), ["s1"], "9 MB over a 6 MB cap: dropping 3 MB is enough")
        XCTAssertEqual(drops.first?.unshippedPairings, ["A"])
    }

    // MARK: - Pulls across rotation

    func testAPullSpanningAMidSessionRotationReturnsEveryLineOnce() async throws {
        let pairing = "desk-rotation-\(UUID().uuidString)"
        UserDefaults.standard.set([pairing], forKey: DiagnosticLog.knownPairingsDefaultsKey)
        DiagnosticLog.setPairingId(pairing)
        DiagnosticLog.segmentMaxBytes = 4_096
        let marker = "rotation-\(UUID().uuidString)"

        DiagnosticLog.log("\(marker) 0", tag: "test")
        DiagnosticLog.flush()
        var cursor = await DiagnosticLog.exportIncrementalSince(sinceSeq: 0, pairingId: pairing).nextSeq
        let before = Set(DiagnosticLog.shared.allLogFiles())

        var received: [String] = []
        for batch in 0..<4 {
            for i in 1...20 {
                DiagnosticLog.log("\(marker) \(batch * 20 + i)", tag: "test")
            }
            DiagnosticLog.flush()
            let pull = await DiagnosticLog.exportIncrementalSince(sinceSeq: cursor, pairingId: pairing)
            received += pull.logs.split(separator: "\n").map(String.init).filter { $0.contains(marker) }
            cursor = pull.nextSeq
        }

        let rotated = Set(DiagnosticLog.shared.allLogFiles()).subtracting(before)
        XCTAssertGreaterThan(rotated.count, 1, "80 lines over 4 KB segments must rotate mid-session")
        let numbers = received.compactMap { line -> Int? in
            guard let msg = (try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])?["msg"] as? String
            else { return nil }
            return Int(msg.split(separator: " ").last ?? "")
        }
        XCTAssertEqual(numbers, Array(1...80), "every line after the first pull arrives exactly once, in order")
    }

    func testTheServersSinceSeqIsRecordedAsItsConfirmation() async {
        let pairing = "desk-confirm-\(UUID().uuidString)"
        DiagnosticLog.setPairingId(pairing)
        DiagnosticLog.log("confirm", tag: "test")
        DiagnosticLog.flush()
        let first = await DiagnosticLog.exportIncrementalSince(sinceSeq: 0, pairingId: pairing)
        _ = await DiagnosticLog.exportIncrementalSince(sinceSeq: first.nextSeq, pairingId: pairing)
        XCTAssertEqual(DiagnosticLog.loadShippedMarks()[pairing], first.nextSeq)
    }

    func testACursorFromAnOlderSeqSpaceShipsFromZero() async {
        let pairing = "desk-reinstall-\(UUID().uuidString)"
        DiagnosticLog.setPairingId(pairing)
        let marker = "reinstall-\(UUID().uuidString)"
        DiagnosticLog.log(marker, tag: "test")
        DiagnosticLog.flush()

        let foreign = 1_000_000_000
        let pull = await DiagnosticLog.exportIncrementalSince(sinceSeq: foreign, pairingId: pairing)
        XCTAssertTrue(pull.logs.contains(marker), "the retained lines ship instead of nothing")
        XCTAssertLessThan(pull.nextSeq, foreign, "the server sees its cursor regress and resets it")
        XCTAssertNil(DiagnosticLog.loadShippedMarks()[pairing], "a foreign cursor confirms nothing")
    }

    // MARK: - Segment names

    func testSessionTagParsesBothSegmentNameShapes() {
        XCTAssertEqual(DiagnosticLog.sessionTag(ofSegment: "session-2026-09-24T10-00-00Z-000000001234.log"),
                       "2026-09-24T10-00-00Z")
        XCTAssertEqual(DiagnosticLog.sessionTag(ofSegment: "session-2026-09-24T10-00-00Z.log"),
                       "2026-09-24T10-00-00Z")
    }
}

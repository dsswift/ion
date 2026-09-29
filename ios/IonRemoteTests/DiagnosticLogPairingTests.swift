import XCTest
import CryptoKit
@testable import IonRemote

/// Pins the diagnostic-log pairing isolation contract:
///   - pairing_id stamped on log lines when set, omitted when nil
///   - parsePairingId extracts pairing_id from JSONL lines
///   - filtered incremental export returns only lines matching the
///     requested pairingId while advancing the seq cursor globally
///   - lines with no pairing_id excluded from filtered exports
///   - every line the filter keeps back is counted, by reason
///   - the counts survive the wire encoding
final class DiagnosticLogPairingTests: XCTestCase {

    override func setUp() {
        super.setUp()
        DiagnosticLog.minLevel = .trace
    }

    override func tearDown() {
        DiagnosticLog.setPairingId(nil)
        DiagnosticLog.minLevel = .info
        super.tearDown()
    }

    // MARK: - pairing_id stamping

    func testPairingIdStampedWhenSet() throws {
        DiagnosticLog.setPairingId("desktop-abc")
        DiagnosticLog.log("pairing stamp test", tag: "pairing", level: .info)
        DiagnosticLog.flush()

        let raw = DiagnosticLog.exportCurrentSession()
        let lines = raw.components(separatedBy: "\n").filter { !$0.isEmpty }
        let matched = lines.compactMap { line -> [String: Any]? in
            guard let data = line.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  (obj["msg"] as? String) == "pairing stamp test" else { return nil }
            return obj
        }
        XCTAssertFalse(matched.isEmpty, "expected log line with msg 'pairing stamp test'")
        let pairingId = matched.last?["pairing_id"] as? String
        XCTAssertEqual(pairingId, "desktop-abc",
                       "pairing_id must be stamped on log lines when set")
    }

    func testPairingIdOmittedWhenNil() throws {
        DiagnosticLog.setPairingId(nil)
        DiagnosticLog.log("no pairing test", tag: "pairing", level: .info)
        DiagnosticLog.flush()

        let raw = DiagnosticLog.exportCurrentSession()
        let lines = raw.components(separatedBy: "\n").filter { !$0.isEmpty }
        let matched = lines.compactMap { line -> [String: Any]? in
            guard let data = line.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  (obj["msg"] as? String) == "no pairing test" else { return nil }
            return obj
        }
        XCTAssertFalse(matched.isEmpty, "expected log line with msg 'no pairing test'")
        XCTAssertNil(matched.last?["pairing_id"],
                     "pairing_id key must be absent when nil (not empty string)")
    }

    // MARK: - The stamp follows the pairing, not one connect path

    private func stampedPairing(ofLineContaining marker: String) -> String? {
        DiagnosticLog.flush()
        let line = DiagnosticLog.exportCurrentSession()
            .components(separatedBy: "\n")
            .last { $0.contains(marker) }
        return line.flatMap(DiagnosticLog.parsePairingId)
    }

    /// Field failure: the app resumed through a path that built a transport
    /// without stamping the log, so every line was written with no pairing_id
    /// and the desktop's pull received nothing. Assigning the transport is the
    /// one step every connect path shares.
    @MainActor
    func testAssigningATransportStampsItsPairing() {
        DiagnosticLog.setPairingId(nil)
        let vm = SessionViewModel()
        vm.transport = FakeRemoteTransport(deviceId: "desk-transport")

        let marker = "transport-stamp-\(UUID().uuidString)"
        DiagnosticLog.log(marker, tag: "pairing", level: .info)
        XCTAssertEqual(stampedPairing(ofLineContaining: marker), "desk-transport")

        // Tearing the transport down (app suspend) must not unstamp the log.
        vm.transport = nil
        let after = "transport-gone-\(UUID().uuidString)"
        DiagnosticLog.log(after, tag: "pairing", level: .info)
        XCTAssertEqual(stampedPairing(ofLineContaining: after), "desk-transport")
    }

    @MainActor
    func testSelectingAPairingStampsIt() {
        let saved = UserDefaults.standard.string(forKey: DiagnosticLog.selectedPairingDefaultsKey)
        defer { UserDefaults.standard.set(saved, forKey: DiagnosticLog.selectedPairingDefaultsKey) }

        let vm = SessionViewModel()
        vm.activeDeviceId = "desk-selected"
        let marker = "select-stamp-\(UUID().uuidString)"
        DiagnosticLog.log(marker, tag: "pairing", level: .info)
        XCTAssertEqual(stampedPairing(ofLineContaining: marker), "desk-selected")

        vm.activeDeviceId = nil
        let cleared = "select-clear-\(UUID().uuidString)"
        DiagnosticLog.log(cleared, tag: "pairing", level: .info)
        XCTAssertNil(stampedPairing(ofLineContaining: cleared))
    }

    // MARK: - parsePairingId

    func testParsePairingIdExtractsValue() {
        let line = #"{"ts":"2026-01-01T00:00:00.000Z","level":"INFO","component":"ios","pairing_id":"desk-1","msg":"x","fields":{}}"#
        XCTAssertEqual(DiagnosticLog.parsePairingId(line), "desk-1")
    }

    func testParsePairingIdReturnsNilWhenAbsent() {
        let line = #"{"ts":"2026-01-01T00:00:00.000Z","level":"INFO","component":"ios","msg":"x","fields":{}}"#
        XCTAssertNil(DiagnosticLog.parsePairingId(line))
    }

    func testParsePairingIdReturnsNilForGarbage() {
        XCTAssertNil(DiagnosticLog.parsePairingId("not json at all"))
        XCTAssertNil(DiagnosticLog.parsePairingId(""))
    }

    // MARK: - Filtered incremental export

    func testFilteredExportReturnsOnlyMatchingPairing() async throws {
        let marker = "pairing-filter-\(UUID().uuidString)"

        DiagnosticLog.setPairingId("desk-A")
        DiagnosticLog.log("line A1 \(marker)", tag: "pairing", level: .info)
        DiagnosticLog.log("line A2 \(marker)", tag: "pairing", level: .info)
        DiagnosticLog.flush()

        DiagnosticLog.setPairingId("desk-B")
        DiagnosticLog.log("line B1 \(marker)", tag: "pairing", level: .info)
        DiagnosticLog.flush()

        // Full pull from 0 to establish baseline cursor
        let baseline = await DiagnosticLog.exportIncrementalSince(sinceSeq: 0)

        // Write more lines for both pairings
        DiagnosticLog.setPairingId("desk-A")
        DiagnosticLog.log("line A3 \(marker)", tag: "pairing", level: .info)
        DiagnosticLog.flush()

        DiagnosticLog.setPairingId("desk-B")
        DiagnosticLog.log("line B2 \(marker)", tag: "pairing", level: .info)
        DiagnosticLog.flush()

        // Filtered pull for desk-A only
        let filteredA = await DiagnosticLog.exportIncrementalSince(
            sinceSeq: baseline.nextSeq, pairingId: "desk-A")
        let aLines = filteredA.logs.components(separatedBy: "\n")
            .filter { $0.contains(marker) }
        XCTAssertEqual(aLines.count, 1, "filtered export must return only desk-A lines")
        XCTAssertTrue(filteredA.logs.contains("line A3 \(marker)"))
        XCTAssertFalse(filteredA.logs.contains("line B2 \(marker)"),
                       "desk-B lines must be excluded from desk-A filtered export")
    }

    func testFilteredExportAdvancesSeqGlobally() async throws {
        let marker = "seq-global-\(UUID().uuidString)"

        // Establish baseline
        let baseline = await DiagnosticLog.exportIncrementalSince(sinceSeq: 0)

        DiagnosticLog.setPairingId("desk-X")
        DiagnosticLog.log("X1 \(marker)", tag: "pairing", level: .info)
        DiagnosticLog.flush()

        DiagnosticLog.setPairingId("desk-Y")
        DiagnosticLog.log("Y1 \(marker)", tag: "pairing", level: .info)
        DiagnosticLog.flush()

        // Filter for desk-X -- should return X1 but cursor advances past Y1 too
        let filtered = await DiagnosticLog.exportIncrementalSince(
            sinceSeq: baseline.nextSeq, pairingId: "desk-X")
        XCTAssertTrue(filtered.logs.contains("X1 \(marker)"))

        // Now pull unfiltered from the filtered result's cursor -- Y1 should
        // NOT re-appear because the cursor advanced globally past it.
        let afterFiltered = await DiagnosticLog.exportIncrementalSince(
            sinceSeq: filtered.nextSeq)
        XCTAssertFalse(afterFiltered.logs.contains("Y1 \(marker)"),
                       "seq cursor must advance globally, not just over filtered lines")
    }

    func testUnstampedLinesExcludedFromFilteredExport() async throws {
        let marker = "unstamped-\(UUID().uuidString)"

        // Write a line with no pairing_id (no pairing selected)
        DiagnosticLog.setPairingId(nil)
        DiagnosticLog.log("no-pairing \(marker)", tag: "pairing", level: .info)
        DiagnosticLog.flush()

        let baseline = await DiagnosticLog.exportIncrementalSince(sinceSeq: 0)

        // Write a line with pairing
        DiagnosticLog.setPairingId("desk-Z")
        DiagnosticLog.log("with-pairing \(marker)", tag: "pairing", level: .info)
        DiagnosticLog.flush()

        // Also write another nil-pairing line
        DiagnosticLog.setPairingId(nil)
        DiagnosticLog.log("also-no-pairing \(marker)", tag: "pairing", level: .info)
        DiagnosticLog.flush()

        let filtered = await DiagnosticLog.exportIncrementalSince(
            sinceSeq: baseline.nextSeq, pairingId: "desk-Z")
        XCTAssertTrue(filtered.logs.contains("with-pairing \(marker)"),
                      "line matching pairing must be included")
        XCTAssertFalse(filtered.logs.contains("also-no-pairing \(marker)"),
                       "lines with no pairing_id must be excluded from filtered export")
    }

    func testFilteredExportCountsWithheldLinesByReason() async throws {
        let marker = "withheld-\(UUID().uuidString)"
        let baseline = await DiagnosticLog.exportIncrementalSince(sinceSeq: 0)

        DiagnosticLog.setPairingId("desk-mine")
        DiagnosticLog.log("mine \(marker)", tag: "pairing", level: .info)
        DiagnosticLog.setPairingId("desk-other")
        DiagnosticLog.log("other \(marker)", tag: "pairing", level: .info)
        DiagnosticLog.setPairingId(nil)
        DiagnosticLog.log("unstamped 1 \(marker)", tag: "pairing", level: .info)
        DiagnosticLog.log("unstamped 2 \(marker)", tag: "pairing", level: .info)
        DiagnosticLog.flush()

        let filtered = await DiagnosticLog.exportIncrementalSince(
            sinceSeq: baseline.nextSeq, pairingId: "desk-mine")
        XCTAssertTrue(filtered.logs.contains("mine \(marker)"))
        XCTAssertFalse(filtered.logs.contains("other \(marker)"))
        XCTAssertFalse(filtered.logs.contains("unstamped 1 \(marker)"))
        XCTAssertFalse(filtered.logs.contains("unstamped 2 \(marker)"))
        // The counts are global over the pull's window, not scoped to this
        // test's marker, so anything else logging concurrently raises them.
        // What is pinned is that no line the filter kept back went uncounted:
        // the three this test wrote are in there, each under its own reason.
        XCTAssertGreaterThanOrEqual(filtered.withheldOtherPairing, 1,
                                    "a line belonging to another pairing must be counted, not dropped unseen")
        XCTAssertGreaterThanOrEqual(filtered.withheldUnstamped, 2,
                                    "a pull that passes over unstamped lines must say how many")

        let unfiltered = await DiagnosticLog.exportIncrementalSince(sinceSeq: 0)
        XCTAssertEqual(unfiltered.withheldUnstamped, 0)
        XCTAssertEqual(unfiltered.withheldOtherPairing, 0)
    }

    func testUnfilteredExportReturnsAllPairings() async throws {
        let marker = "unfiltered-\(UUID().uuidString)"

        let baseline = await DiagnosticLog.exportIncrementalSince(sinceSeq: 0)

        DiagnosticLog.setPairingId("desk-1")
        DiagnosticLog.log("d1 \(marker)", tag: "pairing", level: .info)
        DiagnosticLog.flush()

        DiagnosticLog.setPairingId("desk-2")
        DiagnosticLog.log("d2 \(marker)", tag: "pairing", level: .info)
        DiagnosticLog.flush()

        DiagnosticLog.setPairingId(nil)
        DiagnosticLog.log("none \(marker)", tag: "pairing", level: .info)
        DiagnosticLog.flush()

        // Unfiltered pull returns everything
        let all = await DiagnosticLog.exportIncrementalSince(sinceSeq: baseline.nextSeq)
        let ownLines = all.logs.components(separatedBy: "\n")
            .filter { $0.contains(marker) }
        XCTAssertEqual(ownLines.count, 3,
                       "unfiltered export must return lines from all pairings including nil")
    }
}

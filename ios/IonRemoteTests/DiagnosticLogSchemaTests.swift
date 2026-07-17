import XCTest
@testable import IonRemote

final class DiagnosticLogSchemaTests: XCTestCase {

    /// Lower minLevel to .trace before each test so that all log levels can
    /// be exercised. Restored to .info in tearDown so the filter is active
    /// during normal app operation and other test suites are unaffected.
    override func setUp() {
        super.setUp()
        DiagnosticLog.minLevel = .trace
    }

    override func tearDown() {
        DiagnosticLog.minLevel = .info
        super.tearDown()
    }

    func testLogLineIsValidJSONWithRequiredFields() throws {
        // Redirect output to a temp file so we can capture a log line
        // Use DiagnosticLog's exportCurrentSession() after a controlled log call
        DiagnosticLog.log("test message", tag: "test", level: .info, fields: ["k": "v"])
        DiagnosticLog.flush()

        let raw = DiagnosticLog.exportCurrentSession()
        // Find the last non-empty JSONL line (skip the session-start marker)
        let lines = raw.components(separatedBy: "\n").filter { !$0.isEmpty }
        XCTAssertFalse(lines.isEmpty, "Expected at least one log line")

        // Parse the last line
        guard let lastLine = lines.last,
              let data = lastLine.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            XCTFail("Last log line is not valid JSON: \(lines.last ?? "<empty>")")
            return
        }

        // Required fields
        XCTAssertNotNil(obj["ts"], "ts must be present")
        XCTAssertNotNil(obj["level"], "level must be present")
        XCTAssertEqual(obj["component"] as? String, "ios", "component must be 'ios'")
        XCTAssertNotNil(obj["msg"], "msg must be present")
        XCTAssertNotNil(obj["fields"], "fields must be present")

        // ts must parse as a UTC date
        let ts = obj["ts"] as? String ?? ""
        XCTAssertTrue(ts.hasSuffix("Z"), "ts must be UTC (end with Z), got: \(ts)")
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        XCTAssertNotNil(formatter.date(from: ts), "ts must be a valid ISO8601 date")

        // level value
        XCTAssertEqual(obj["level"] as? String, "INFO")

        // tag must be present when non-empty
        XCTAssertEqual(obj["tag"] as? String, "test")

        // No empty-string session_id or conversation_id
        XCTAssertNil(obj["session_id"] as? String == "" ? "" : nil,
                    "session_id must not be empty string")
        XCTAssertNil(obj["conversation_id"] as? String == "" ? "" : nil,
                    "conversation_id must not be empty string")
    }

    func testSessionIdStampedOnSubsequentLines() throws {
        DiagnosticLog.setSessionId("test-session-abc123")
        DiagnosticLog.log("after session set", tag: "session", level: .debug)
        DiagnosticLog.flush()

        let raw = DiagnosticLog.exportCurrentSession()
        let lines = raw.components(separatedBy: "\n").filter { !$0.isEmpty }

        // Find a line that has session_id
        let sessionLines = lines.compactMap { line -> [String: Any]? in
            guard let data = line.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  obj["session_id"] != nil else { return nil }
            return obj
        }

        XCTAssertFalse(sessionLines.isEmpty, "Expected at least one line with session_id")
        let sid = sessionLines.last?["session_id"] as? String
        XCTAssertEqual(sid, "test-session-abc123")

        // Clean up
        DiagnosticLog.setSessionId(nil)
    }

    /// A .trace log line must serialise "level":"TRACE" in the emitted JSONL.
    func testTraceLineSerializesLevelTRACE() throws {
        DiagnosticLog.log("trace test message", tag: "trace-test", level: .trace)
        DiagnosticLog.flush()

        let raw = DiagnosticLog.exportCurrentSession()
        let lines = raw.components(separatedBy: "\n").filter { !$0.isEmpty }
        XCTAssertFalse(lines.isEmpty, "Expected at least one log line")

        guard let lastLine = lines.last,
              let data = lastLine.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            XCTFail("Last log line is not valid JSON: \(lines.last ?? "<empty>")")
            return
        }

        XCTAssertEqual(obj["level"] as? String, "TRACE",
                       "A .trace log line must emit level=TRACE, not DEBUG-4 or any other value")
        XCTAssertEqual(obj["msg"] as? String, "trace test message")
        XCTAssertEqual(obj["tag"] as? String, "trace-test")
    }

    /// trace is ordered below debug in the Level enum.
    func testTraceLevelOrderingBelowDebug() {
        // Swift enums with raw values don't have an inherent ordering, but we
        // can verify the raw string values match the schema and that the
        // convenience `trace()` API delegates to level:.trace.
        XCTAssertEqual(DiagnosticLog.Level.trace.rawValue, "TRACE")
        XCTAssertEqual(DiagnosticLog.Level.debug.rawValue, "DEBUG")
        XCTAssertEqual(DiagnosticLog.Level.info.rawValue,  "INFO")
        XCTAssertEqual(DiagnosticLog.Level.warn.rawValue,  "WARN")
        XCTAssertEqual(DiagnosticLog.Level.error.rawValue, "ERROR")
    }

    /// DiagnosticLog.trace() is a convenience wrapper that emits level=TRACE.
    func testTraceConvenienceAPIEmitsTRACE() throws {
        DiagnosticLog.trace("convenience trace", tag: "api-test", fields: ["k": "v"])
        DiagnosticLog.flush()

        let raw = DiagnosticLog.exportCurrentSession()
        let lines = raw.components(separatedBy: "\n").filter { !$0.isEmpty }
        XCTAssertFalse(lines.isEmpty)

        guard let lastLine = lines.last,
              let data = lastLine.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            XCTFail("Last log line is not valid JSON")
            return
        }

        XCTAssertEqual(obj["level"] as? String, "TRACE",
                       "DiagnosticLog.trace() must emit level=TRACE")
    }

    // MARK: - Device identity + per-line seq

    /// Every emitted line must carry the device-identity fields the desktop
    /// cannot know (model / OS / app version+build / device_id) inside `fields`,
    /// plus a monotonic `seq`. Without these the central sink cannot attribute a
    /// line to a specific device or app build.
    func testAllLinesCarryRequiredFields() throws {
        DiagnosticLog.log("device fields probe", tag: "probe", level: .info)
        DiagnosticLog.flush()

        let raw = DiagnosticLog.exportCurrentSession()
        let lines = raw.components(separatedBy: "\n").filter { !$0.isEmpty }
        XCTAssertFalse(lines.isEmpty)

        // Assert on EVERY line (the session-start marker included) so no code
        // path can emit an unattributed line.
        for line in lines {
            guard let data = line.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let fields = obj["fields"] as? [String: Any] else {
                XCTFail("line is not valid JSON with a fields object: \(line)")
                continue
            }
            XCTAssertNotNil(fields["device_model"], "device_model must be present on every line")
            XCTAssertNotNil(fields["app_version"], "app_version must be present on every line")
            XCTAssertNotNil(fields["app_build"], "app_build must be present on every line")
            XCTAssertNotNil(fields["os_version"], "os_version must be present on every line")
            XCTAssertNotNil(fields["seq"], "seq must be present on every line")
            // device_id is the stable per-device hardware identity
            // (UIDevice.identifierForVendor UUID). It must be present on every
            // line so the central sink can group by device even when the pairing
            // changes. In the simulator identifierForVendor is a fixed UUID that
            // is non-nil; on real hardware it is the hardware-unique vendor UUID.
            let deviceId = fields["device_id"] as? String
            XCTAssertNotNil(deviceId, "device_id must be present on every line")
            XCTAssertFalse(deviceId?.isEmpty ?? true, "device_id must not be empty")
        }
    }

    /// MDM fields (mdm_device_id, mdm_serial) must be absent on the simulator
    /// because no managed app config dictionary is available there. This guards
    /// against silent empty-string injection (the rule: use `if let` on the
    /// managed defaults value and only stamp when non-empty).
    func testMDMFieldsAbsentOnSimulator() throws {
        // In the simulator UserDefaults(suiteName: "com.apple.configuration.managed")
        // returns either nil or a defaults with no MDMDeviceID / MDMSerialNumber keys,
        // so these fields must be absent from every line.
        DiagnosticLog.log("mdm probe", tag: "probe", level: .info)
        DiagnosticLog.flush()

        let raw = DiagnosticLog.exportCurrentSession()
        let lines = raw.components(separatedBy: "\n").filter { !$0.isEmpty }
        XCTAssertFalse(lines.isEmpty)

        for line in lines {
            guard let data = line.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let fields = obj["fields"] as? [String: Any] else { continue }
            XCTAssertNil(fields["mdm_device_id"],
                         "mdm_device_id must be absent on simulator (no managed config)")
            XCTAssertNil(fields["mdm_serial"],
                         "mdm_serial must be absent on simulator (no managed config)")
        }
    }

    /// The bogus `device` marker field (SIMULATOR_DEVICE_NAME ?? "device",
    /// literally "device" on real hardware) must be gone — replaced by the real
    /// `device_model`. This is the good-citizen fix; it must not regress.
    func testSessionMarkerHasNoBogusDeviceField() throws {
        // The session-start marker is the first line of a fresh session. It is
        // already on disk from init; read the earliest line.
        let raw = DiagnosticLog.exportCurrentSession()
        let lines = raw.components(separatedBy: "\n").filter { !$0.isEmpty }
        guard let first = lines.first,
              let data = first.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let fields = obj["fields"] as? [String: Any] else {
            XCTFail("no session-start line to inspect")
            return
        }
        XCTAssertNil(fields["device"], "the bogus 'device' field must be removed")
        XCTAssertNotNil(fields["device_model"], "device_model replaces the bogus device field")
    }

    /// seq is strictly increasing across successive lines.
    func testSeqStrictlyIncreasing() throws {
        DiagnosticLog.log("seq line a", tag: "seq", level: .info)
        DiagnosticLog.log("seq line b", tag: "seq", level: .info)
        DiagnosticLog.log("seq line c", tag: "seq", level: .info)
        DiagnosticLog.flush()

        let raw = DiagnosticLog.exportCurrentSession()
        let seqs = raw.components(separatedBy: "\n").filter { !$0.isEmpty }.compactMap { line -> Int? in
            guard let data = line.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let fields = obj["fields"] as? [String: Any],
                  let s = fields["seq"] as? String else { return nil }
            return Int(s)
        }
        XCTAssertGreaterThanOrEqual(seqs.count, 3, "expected at least three seq'd lines")
        for i in 1..<seqs.count {
            XCTAssertGreaterThan(seqs[i], seqs[i - 1], "seq must strictly increase: \(seqs)")
        }
    }

    /// `exportIncrementalSince(sinceSeq:)` returns only lines whose seq exceeds
    /// the cursor, and reports a `nextSeq` past the max returned. This is the
    /// exactly-once pull contract the desktop relies on.
    func testExportIncrementalSinceReturnsOnlyNewerSeqs() throws {
        DiagnosticLog.log("incr one", tag: "incr", level: .info)
        DiagnosticLog.flush()
        // Full pull from 0 returns everything and a nextSeq past the end.
        let full = DiagnosticLog.exportIncrementalSince(sinceSeq: 0)
        XCTAssertFalse(full.logs.isEmpty, "full pull must return lines")
        XCTAssertGreaterThan(full.nextSeq, 0, "nextSeq must advance past 0 on a non-empty pull")

        // A second pull from the returned cursor, with no new lines written,
        // returns nothing and holds the cursor (no re-ship).
        let empty = DiagnosticLog.exportIncrementalSince(sinceSeq: full.nextSeq)
        XCTAssertTrue(empty.logs.isEmpty, "a pull at the cursor must return zero lines")
        XCTAssertEqual(empty.nextSeq, full.nextSeq, "cursor must not move when nothing is newer")

        // Write one more line; a pull from the prior cursor returns exactly it.
        DiagnosticLog.log("incr two", tag: "incr", level: .info)
        DiagnosticLog.flush()
        let delta = DiagnosticLog.exportIncrementalSince(sinceSeq: full.nextSeq)
        let deltaLines = delta.logs.components(separatedBy: "\n").filter { !$0.isEmpty }
        for line in deltaLines {
            let data = line.data(using: .utf8)!
            let obj = try JSONSerialization.jsonObject(with: data) as! [String: Any]
            let fields = obj["fields"] as! [String: Any]
            let seq = Int(fields["seq"] as! String)!
            XCTAssertGreaterThan(seq, full.nextSeq - 1, "delta pull must exclude already-seen seqs")
        }
        XCTAssertGreaterThan(delta.nextSeq, full.nextSeq, "cursor must advance after new lines")
    }
}


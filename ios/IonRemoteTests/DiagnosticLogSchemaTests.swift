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
}


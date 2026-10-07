import XCTest
@testable import IonRemote

/// The phone's own latency window: the round trip is timed from the socket
/// write, the wait before it is queue time on its own, the transport is the
/// real route, and the environment is the one the welcome named.
final class StudioClientLatencyTests: XCTestCase {

    func testTheWindowReportsTheRouteAndTheEnvironmentNotTheClientId() throws {
        let latency = StudioClientLatency()
        latency.noteActionEnqueued(id: "a")
        latency.noteActionSent(id: "a")
        latency.noteActionResult(id: "a")
        var window = try XCTUnwrap(latency.window())
        XCTAssertEqual(window.fields["transport"], "unknown", "before a socket is adopted the route is unknown, never a made-up label")
        XCTAssertNil(window.fields["environment_id"], "the environment is absent until the welcome names it")

        latency.noteRoute(.relay)
        latency.noteEnvironment("env-7")
        window = try XCTUnwrap(latency.window())
        XCTAssertEqual(window.fields["transport"], "relay")
        XCTAssertEqual(window.fields["environment_id"], "env-7")
        XCTAssertNil(window.fields["client_id"])
    }

    func testTheRoundTripStartsAtTheSocketWriteAndTheQueueWaitIsReportedApart() throws {
        let latency = StudioClientLatency(route: .tcp, environmentId: "env-1")
        let t0 = Date()
        // Held 300 ms before the welcome released it, then answered 40 ms after the write.
        latency.noteActionEnqueued(id: "a", at: t0)
        latency.noteActionSent(id: "a", at: t0.addingTimeInterval(0.3))
        latency.noteActionResult(id: "a", at: t0.addingTimeInterval(0.34))
        // Written at once, answered 20 ms later.
        latency.noteActionEnqueued(id: "b", at: t0)
        latency.noteActionSent(id: "b", at: t0)
        latency.noteActionResult(id: "b", at: t0.addingTimeInterval(0.02))

        let window = try XCTUnwrap(latency.window())
        XCTAssertEqual(window.numbers["actions"], 2)
        XCTAssertEqual(window.numbers["action_p50_ms"], 20)
        XCTAssertEqual(window.numbers["action_max_ms"], 40, "the 300 ms in the queue is not the wire's")
        XCTAssertEqual(window.numbers["queued"], 2)
        XCTAssertEqual(window.numbers["queue_p50_ms"], 0)
        XCTAssertEqual(window.numbers["action_timeouts"], 0)
    }

    func testAnActionThatNeverLeftIsNotARoundTrip() throws {
        let latency = StudioClientLatency(route: .tcp)
        latency.noteActionEnqueued(id: "never")
        XCTAssertFalse(latency.hasSamples)
        latency.noteActionResult(id: "never")
        XCTAssertNil(latency.window(), "an answer to a frame that was never written measures nothing")
    }

    func testTimeoutsAreCountedNotAveragedIn() throws {
        let latency = StudioClientLatency(route: .tcp)
        let start = Date()
        for i in 1...10 {
            latency.noteActionEnqueued(id: "a\(i)", at: start)
            latency.noteActionSent(id: "a\(i)", at: start)
            latency.noteActionResult(id: "a\(i)", at: start.addingTimeInterval(Double(i) / 100))
        }
        latency.noteActionEnqueued(id: "gone", at: start)
        latency.noteActionSent(id: "gone", at: start)
        latency.noteActionTimeout(id: "gone")

        let window = try XCTUnwrap(latency.window())
        XCTAssertEqual(window.numbers["action_timeouts"], 1)
        XCTAssertEqual(window.numbers["actions"], 10)
        XCTAssertEqual(window.numbers["action_p50_ms"], 50)
        XCTAssertEqual(StudioClientLatency.percentile([10, 20, 30, 40], 50), 20)
        XCTAssertEqual(StudioClientLatency.percentile([], 95), 0)
    }

    func testTheWindowLineCarriesItsNumbersAsNumbers() throws {
        let latency = StudioClientLatency(route: .relay, environmentId: "env-9")
        latency.noteActionEnqueued(id: "a")
        latency.noteActionSent(id: "a")
        latency.noteActionResult(id: "a")
        latency.flush()
        XCTAssertFalse(latency.hasSamples, "a flush starts a fresh window")
        DiagnosticLog.flush()
        let line = try XCTUnwrap(DiagnosticLog.exportCurrentSession().components(separatedBy: "\n").last { $0.contains("\"client window\"") && $0.contains("env-9") })
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
        XCTAssertEqual(obj["tag"] as? String, "wire-latency")
        let fields = try XCTUnwrap(obj["fields"] as? [String: Any])
        XCTAssertEqual(fields["transport"] as? String, "relay")
        XCTAssertEqual(fields["environment_id"] as? String, "env-9")
        XCTAssertNotNil(fields["action_p50_ms"] as? Double, "a percentile is a JSON number")
        XCTAssertNotNil(fields["queue_p50_ms"] as? Double)
        XCTAssertNil(obj["trace_id"], "a window is not a span")
    }
}

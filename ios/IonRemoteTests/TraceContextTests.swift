import XCTest
import CryptoKit
@testable import IonRemote

/// The phone's hop in a prompt's trace: traceparent parsing matches the engine
/// (engine/internal/utils/traceparent_test.go carries the same table), a span
/// writes the canonical span log line once, and the prompt's traceparent rides
/// both the `session.prompt` arguments and the frame's outer envelope.
final class TraceContextTests: XCTestCase {

    private let trace = "4bf92f3577b34da6a3ce929d0e0e4736"
    private let span = "00f067aa0ba902b7"

    // MARK: - Parsing

    func testParseMatchesTheEngineTable() {
        let cases: [(String, String, Bool)] = [
            ("valid", "00-\(trace)-\(span)-01", true),
            ("valid unsampled", "00-\(trace)-\(span)-00", true),
            ("surrounding space", "  00-\(trace)-\(span)-01 ", true),
            ("empty", "", false),
            ("unknown version", "01-\(trace)-\(span)-01", false),
            ("zero trace", "00-00000000000000000000000000000000-\(span)-01", false),
            ("zero span", "00-\(trace)-0000000000000000-01", false),
            ("uppercase", "00-4BF92F3577B34DA6A3CE929D0E0E4736-\(span)-01", false),
            ("short span", "00-\(trace)-00f067aa-01", false),
            ("missing flags", "00-\(trace)-\(span)", false),
        ]
        for (name, value, ok) in cases {
            let parsed = TraceContext.parse(value)
            if ok {
                XCTAssertEqual(parsed, TraceContext.Parent(traceId: trace, spanId: span), name)
            } else {
                XCTAssertNil(parsed, name)
            }
        }
    }

    func testMintedIdsRoundTripThroughATraceparent() {
        let traceId = TraceContext.newTraceId()
        let spanId = TraceContext.newSpanId()
        XCTAssertTrue(TraceContext.isValidTraceId(traceId))
        XCTAssertTrue(TraceContext.isValidSpanId(spanId))
        XCTAssertEqual(TraceContext.parse(TraceContext.format(traceId: traceId, spanId: spanId)), TraceContext.Parent(traceId: traceId, spanId: spanId))
    }

    // MARK: - Spans

    func testASpanJoinsItsParentAndWritesOnce() {
        let written = Collected<TraceSpan.Record>()
        let start = Date(timeIntervalSince1970: 1000)
        let s = TraceSpan(name: "prompt.send", parent: "00-\(trace)-\(span)-01", kind: .client, attributes: ["tab_id": "t1"], start: start) {
            written.append($0)
        }
        XCTAssertTrue(s.joined)
        XCTAssertEqual(s.traceId, trace)
        XCTAssertEqual(TraceContext.parse(s.traceparent), TraceContext.Parent(traceId: trace, spanId: s.spanId))
        s.end(attributes: ["accepted": "true"], at: start.addingTimeInterval(0.25))
        s.end(error: "late", at: start.addingTimeInterval(1))
        XCTAssertEqual(written.values.count, 1)
        XCTAssertEqual(written.values.first?.durationMs, 250)
        XCTAssertEqual(written.values.first?.attributes, ["tab_id": "t1", "accepted": "true"])
        XCTAssertNil(written.values.first?.error)
    }

    func testAnInvalidParentStartsANewTrace() {
        let s = TraceSpan(name: "prompt.send", parent: "garbage", writer: { _ in })
        XCTAssertFalse(s.joined)
        XCTAssertNil(s.parentSpanId)
        XCTAssertTrue(TraceContext.isValidTraceId(s.traceId))
    }

    func testThePromptBookClosesTheSpanWithTheServersAnswer() {
        let written = Collected<TraceSpan.Record>()
        let book = PromptTraceBook { attributes, conversationId in
            TraceSpan(name: "prompt.send", kind: .client, attributes: attributes, conversationId: conversationId) { written.append($0) }
        }
        _ = book.open(clientMsgId: "m-1", tabId: "t1", conversationId: "c1")
        XCTAssertNotNil(book.close(clientMsgId: "m-1", accepted: false, error: "locked"))
        XCTAssertNil(book.close(clientMsgId: "m-1", accepted: true, error: nil), "a span closes once")
        XCTAssertEqual(written.values.first?.error, "locked")
        XCTAssertEqual(written.values.first?.attributes["accepted"], "false")
        XCTAssertEqual(written.values.first?.conversationId, "c1")
        XCTAssertEqual(written.values.first?.attributes["peer.service"], "ion-server", "the client span names its callee")
    }

    /// The server's log pull persists the line as written, and the engine's
    /// egress tailer recognizes it only in this shape.
    func testASpanIsWrittenAsTheCanonicalSpanLine() throws {
        let record = TraceSpan.Record(
            name: "prompt.send", traceId: trace, spanId: span, parentSpanId: nil, kind: .client, durationMs: 812.5,
            attributes: ["surface": "ios", "span_id": "spoof"], conversationId: "1780093348767-c1c03e998388", error: nil
        )
        DiagnosticLog.logSpan(record)
        DiagnosticLog.flush()
        let line = try XCTUnwrap(DiagnosticLog.exportCurrentSession().components(separatedBy: "\n").last { $0.contains("\"prompt.send\"") })
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
        XCTAssertEqual(obj["tag"] as? String, "span")
        XCTAssertEqual(obj["msg"] as? String, "prompt.send")
        XCTAssertEqual(obj["trace_id"] as? String, trace)
        XCTAssertEqual(obj["conversation_id"] as? String, "1780093348767-c1c03e998388")
        let fields = try XCTUnwrap(obj["fields"] as? [String: Any])
        XCTAssertEqual(fields["span_id"] as? String, span, "an attribute never overwrites the span's own id")
        XCTAssertEqual(fields["span_kind"] as? String, "client")
        XCTAssertEqual(fields["duration_ms"] as? Double, 812.5, "duration_ms is a JSON number")
        XCTAssertNil(fields["parent_span_id"])
        XCTAssertNil(fields["trace_id"])
    }

    // MARK: - Wire

    func testThePromptCarriesItsTraceparentInTheArgumentsAndOnTheEnvelope() throws {
        let traceparent = "00-\(trace)-\(span)-01"
        let mapping = StudioTransportCommandMapping(benchPath: { _, _ in "/repo/.ion/bench" })
        let request = mapping.request(for: .prompt(tabId: "t1", text: "hi", clientMsgId: "m-1", traceparent: traceparent))
        guard case .action(let call, _) = request else { return XCTFail("expected an action, got \(String(describing: request))") }
        XCTAssertEqual(call.action, "session.prompt")
        XCTAssertEqual(call.traceparent, traceparent)
        XCTAssertEqual(call.args.first?["traceparent"]?.stringValue, traceparent)

        let untraced = mapping.request(for: .prompt(tabId: "t1", text: "hi"))
        guard case .action(let plain, _) = untraced else { return XCTFail("expected an action") }
        XCTAssertNil(plain.traceparent)
    }

    func testTheTransportHandsThePromptsTraceparentToTheConnection() async throws {
        let traceparent = "00-\(trace)-\(span)-01"
        let connection = FakeStudioConnection()
        let transport = StudioTransport(deviceId: "device-1", connection: connection)
        await transport.start()
        try await transport.send(.prompt(tabId: "t1", text: "hi", clientMsgId: "m-1", traceparent: traceparent))
        XCTAssertEqual(connection.submittedActions.map(\.action), ["session.prompt"])
        XCTAssertEqual(connection.submittedTraceparents, [traceparent])
        transport.stop()
    }

    func testTheSealedEnvelopeCarriesTheTraceparentInPlaintextBesideTheSealedFrame() throws {
        let key = SymmetricKey(size: .bits256)
        let traceparent = "00-\(trace)-\(span)-01"
        let sealed = try SealedEnvelope.seal(text: "{\"type\":\"studio_action\"}", key: key, traceparent: traceparent)
        let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(sealed.utf8)) as? [String: Any])
        XCTAssertEqual(obj["traceparent"] as? String, traceparent)
        XCTAssertEqual(SealedEnvelope.open(sealed, key: key)?.bytes, Data("{\"type\":\"studio_action\"}".utf8))

        let plain = try SealedEnvelope.seal(text: "{}", key: key)
        XCTAssertFalse(plain.contains("traceparent"), "an untraced frame's envelope has no traceparent key")
    }
}

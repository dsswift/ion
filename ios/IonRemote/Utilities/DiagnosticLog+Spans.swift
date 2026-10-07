import Foundation
import os

// MARK: - Span log lines

extension DiagnosticLog {

    /// The tag that marks a line as a span record for the span exporters.
    static let spanTag = "span"

    /// What a span line carries beyond an ordinary line: its top-level
    /// `trace_id`, the conversation the span belongs to, and the numeric
    /// fields (`duration_ms`) the exporters read as numbers, not strings.
    /// A line that is not a span (`log(_:numbers:)`) carries numbers alone.
    struct SpanStamp: Sendable {
        let traceId: String?
        let conversationId: String?
        let numbers: [String: Double]
    }

    /// Writes one finished span as the canonical span log line: `tag` span,
    /// `msg` the span name, top-level `trace_id`, and in `fields` the span's
    /// `span_id`, `parent_span_id`, `duration_ms` (a number), `span_kind`,
    /// `error`, and its attributes. The line's `ts` is when it is written, the
    /// span's end. Attributes never overwrite the span's own keys.
    ///
    /// The same span ends its `OSSignposter` interval here, so Instruments
    /// shows the span the log shows.
    static func logSpan(_ record: TraceSpan.Record) {
        endSignpost(spanId: record.spanId)
        var fields = record.attributes
        for key in ["span_id", "parent_span_id", "duration_ms", "span_kind", "error", "trace_id", "conversation_id"] {
            fields.removeValue(forKey: key)
        }
        fields["span_id"] = record.spanId
        if let parent = record.parentSpanId { fields["parent_span_id"] = parent }
        fields["span_kind"] = record.kind.rawValue
        if let error = record.error { fields["error"] = error }
        let stamp = SpanStamp(traceId: record.traceId, conversationId: record.conversationId, numbers: ["duration_ms": record.durationMs])
        let level: Level = record.error == nil ? .info : .warn
        guard level >= minLevel else { return }
        shared.append(record.name, tag: spanTag, level: level, fields: fields, span: stamp)
    }

    /// An ordinary line whose `numbers` are written as JSON numbers beside the
    /// string `fields`, for a measurement a dashboard aggregates (a latency
    /// window, a MetricKit sample). A key in both is written once, as a number.
    static func log(_ msg: String, tag: String, level: Level = .info, fields: [String: String] = [:], numbers: [String: Double]) {
        guard level >= minLevel else { return }
        var strings = fields
        for key in numbers.keys { strings.removeValue(forKey: key) }
        shared.append(msg, tag: tag, level: level, fields: strings, span: SpanStamp(traceId: nil, conversationId: nil, numbers: numbers))
    }

    // MARK: - Signposts

    /// The one `os` API used outside `DiagnosticLog.swift`, and it lives inside
    /// `DiagnosticLog`: a signpost is Instruments' view of a span, not a log
    /// line, so it reaches no operator and replaces nothing `logSpan` writes.
    private static let signposter = OSSignposter(subsystem: Bundle.main.bundleIdentifier ?? "ion.mobile", category: "spans")
    private static let signpostLock = NSLock()
    private static var openSignposts: [String: OSSignpostIntervalState] = [:]
    /// Spans whose end never came stay here until the oldest is evicted, so an
    /// abandoned span costs one dictionary slot and nothing else.
    private static let maxOpenSignposts = 256
    private static var signpostOrder: [String] = []

    /// Opens the signpost interval for a span that just started.
    static func beginSignpost(name: String, spanId: String) {
        let state = signposter.beginInterval("span", id: signposter.makeSignpostID(), "\(name, privacy: .public)")
        signpostLock.withLock {
            openSignposts[spanId] = state
            signpostOrder.append(spanId)
            while signpostOrder.count > maxOpenSignposts {
                openSignposts.removeValue(forKey: signpostOrder.removeFirst())
            }
        }
    }

    private static func endSignpost(spanId: String) {
        let state = signpostLock.withLock { () -> OSSignpostIntervalState? in
            guard let state = openSignposts.removeValue(forKey: spanId) else { return nil }
            signpostOrder.removeAll { $0 == spanId }
            return state
        }
        guard let state else { return }
        signposter.endInterval("span", state)
    }
}

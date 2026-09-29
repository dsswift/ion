import Foundation

// MARK: - Span log lines

extension DiagnosticLog {

    /// The tag that marks a line as a span record for the span exporters.
    static let spanTag = "span"

    /// What a span line carries beyond an ordinary line: its top-level
    /// `trace_id`, the conversation the span belongs to, and the numeric
    /// fields (`duration_ms`) the exporters read as numbers, not strings.
    struct SpanStamp: Sendable {
        let traceId: String
        let conversationId: String?
        let numbers: [String: Double]
    }

    /// Writes one finished span as the canonical span log line: `tag` span,
    /// `msg` the span name, top-level `trace_id`, and in `fields` the span's
    /// `span_id`, `parent_span_id`, `duration_ms` (a number), `span_kind`,
    /// `error`, and its attributes. The line's `ts` is when it is written, the
    /// span's end. Attributes never overwrite the span's own keys.
    static func logSpan(_ record: TraceSpan.Record) {
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
}

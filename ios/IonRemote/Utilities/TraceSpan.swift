import Foundation

/// One timed span in a prompt's trace, written as a span log line when it
/// ends (`DiagnosticLog.logSpan`). The line reaches the paired server with the
/// rest of the phone's log and the log egress ships it as an OTLP span. See
/// docs/observability/log-schema.md § Spans.
final class TraceSpan: @unchecked Sendable {

    enum Kind: String, Sendable {
        case client
        case server
        case `internal`
    }

    /// What `end` hands to the writer.
    struct Record: Equatable, Sendable {
        let name: String
        let traceId: String
        let spanId: String
        let parentSpanId: String?
        let kind: Kind
        let durationMs: Double
        let attributes: [String: String]
        let conversationId: String?
        let error: String?
    }

    let name: String
    let traceId: String
    let spanId: String
    let parentSpanId: String?
    let kind: Kind
    let conversationId: String?
    private let attributes: [String: String]
    private let start: Date
    private let writer: @Sendable (Record) -> Void
    private let lock = NSLock()
    private var ended = false

    /// This span as the parent of the next hop's span.
    var traceparent: String { TraceContext.format(traceId: traceId, spanId: spanId) }

    /// True when the span joined a caller's trace; false when it started a new one.
    var joined: Bool { parentSpanId != nil }

    /// Starts a span. It joins `parent`'s trace when that parses, and starts a new trace otherwise.
    init(
        name: String,
        parent: String? = nil,
        kind: Kind = .internal,
        attributes: [String: String] = [:],
        conversationId: String? = nil,
        start: Date = Date(),
        writer: @escaping @Sendable (Record) -> Void = { DiagnosticLog.logSpan($0) }
    ) {
        let parsed = parent.flatMap(TraceContext.parse)
        self.name = name
        self.traceId = parsed?.traceId ?? TraceContext.newTraceId()
        self.spanId = TraceContext.newSpanId()
        self.parentSpanId = parsed?.spanId
        self.kind = kind
        self.attributes = attributes
        self.conversationId = conversationId
        self.start = start
        self.writer = writer
    }

    /// Finishes the span and writes it. Only the first call writes; it returns
    /// the record it wrote, and later calls return nil.
    @discardableResult
    func end(attributes extra: [String: String] = [:], error: String? = nil, at end: Date = Date()) -> Record? {
        let first = lock.withLock { () -> Bool in
            guard !ended else { return false }
            ended = true
            return true
        }
        guard first else { return nil }
        let record = Record(
            name: name, traceId: traceId, spanId: spanId, parentSpanId: parentSpanId, kind: kind,
            durationMs: max(0, end.timeIntervalSince(start) * 1000),
            attributes: attributes.merging(extra) { _, new in new },
            conversationId: conversationId, error: error
        )
        writer(record)
        return record
    }
}

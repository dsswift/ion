import Foundation

/// One timed span in a trace, written as a span log line when it ends
/// (`DiagnosticLog.logSpan`). The line reaches the paired server with the
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

    typealias Writer = @Sendable (Record) -> Void

    let name: String
    let traceId: String
    let spanId: String
    let parentSpanId: String?
    let kind: Kind
    let conversationId: String?
    private let attributes: [String: String]
    private let start: Date
    private let writer: Writer
    private let lock = NSLock()
    private var ended = false

    /// This span as the parent of the next hop's span.
    var traceparent: String { TraceContext.format(traceId: traceId, spanId: spanId) }

    /// True when the span joined a caller's trace; false when it started a new one.
    var joined: Bool { parentSpanId != nil }

    /// Starts a span.
    ///
    /// It joins `parent`'s trace as a child when that parses. Otherwise, when
    /// `traceId` is a valid trace id, it becomes a second root span of that
    /// trace (`prompt.visible` beside `prompt.send`). Otherwise it starts a new
    /// trace. The signed-in identity, when one is known (`TraceSpan.user`), is
    /// stamped as the `user` attribute of every span.
    init(
        name: String,
        parent: String? = nil,
        traceId joinTraceId: String? = nil,
        kind: Kind = .internal,
        attributes: [String: String] = [:],
        conversationId: String? = nil,
        start: Date = Date(),
        writer: Writer? = nil
    ) {
        let parsed = parent.flatMap(TraceContext.parse)
        let joined = joinTraceId.flatMap { TraceContext.isValidTraceId($0) ? $0 : nil }
        self.name = name
        self.traceId = parsed?.traceId ?? joined ?? TraceContext.newTraceId()
        self.spanId = TraceContext.newSpanId()
        self.parentSpanId = parsed?.spanId
        self.kind = kind
        var stamped = attributes
        if stamped["user"] == nil, let user = TraceSpan.user { stamped["user"] = user }
        self.attributes = stamped
        self.conversationId = conversationId
        self.start = start
        self.writer = writer ?? TraceSpan.defaultWriter
        DiagnosticLog.beginSignpost(name: name, spanId: spanId)
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

    // MARK: - Process-wide context

    private static let contextLock = NSLock()
    private static var storedUser: String?
    private static var storedWriter: Writer?

    /// The signed-in identity this phone connects as, when one is known: the
    /// welcome's principal email or username. A `paired:` subject is a pairing,
    /// not a person, and leaves this nil.
    static var user: String? {
        get { contextLock.withLock { storedUser } }
        set { contextLock.withLock { storedUser = newValue } }
    }

    /// Where a span with no writer of its own goes: the span log line, or the
    /// writer a test installed with `installWriter`.
    static var defaultWriter: Writer {
        if let installed = contextLock.withLock({ storedWriter }) { return installed }
        return { DiagnosticLog.logSpan($0) }
    }

    /// Test seam: every span started without an explicit writer is handed to
    /// `writer` until `resetWriter()`.
    static func installWriter(_ writer: @escaping Writer) {
        contextLock.withLock { storedWriter = writer }
    }

    static func resetWriter() {
        contextLock.withLock { storedWriter = nil }
    }
}

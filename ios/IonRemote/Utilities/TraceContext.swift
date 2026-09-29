import Foundation

/// W3C trace-context ids for the phone's hop in a prompt's trace.
///
/// A trace follows one prompt across processes: the phone mints the trace and
/// its root span, sends `traceparent` to the next hop, and each hop records
/// its own span as a child. The parse rules match the engine's
/// (`engine/internal/utils/traceparent.go`) and the TypeScript surfaces'
/// (`packages/shared/src/trace-context.ts`), so a value one side accepts the
/// others accept too. See docs/observability/log-schema.md § Spans.
enum TraceContext {

    /// A parsed `traceparent`: the trace and the span that is the next hop's parent.
    struct Parent: Equatable, Sendable {
        let traceId: String
        let spanId: String
    }

    private static let traceIdHexLength = 32
    private static let spanIdHexLength = 16

    /// A W3C trace-id: 32 lowercase hex characters, not all zero.
    static func isValidTraceId(_ id: String) -> Bool {
        isLowerHexId(id, length: traceIdHexLength)
    }

    /// A W3C span-id: 16 lowercase hex characters, not all zero.
    static func isValidSpanId(_ id: String) -> Bool {
        isLowerHexId(id, length: spanIdHexLength)
    }

    /// A fresh trace-id.
    static func newTraceId() -> String {
        randomId(bytes: traceIdHexLength / 2, valid: isValidTraceId)
    }

    /// A fresh span-id.
    static func newSpanId() -> String {
        randomId(bytes: spanIdHexLength / 2, valid: isValidSpanId)
    }

    /// A sampled version-00 `traceparent` value.
    static func format(traceId: String, spanId: String) -> String {
        "00-\(traceId)-\(spanId)-01"
    }

    /// Parses a `traceparent` (`00-<trace-id>-<parent-id>-<flags>`). Nil for any
    /// value that is not version 00 with a valid trace-id and span-id.
    static func parse(_ value: String) -> Parent? {
        let parts = value.trimmingCharacters(in: .whitespaces).split(separator: "-", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 4, parts[0] == "00", parts[3].count == 2 else { return nil }
        guard isValidTraceId(parts[1]), isValidSpanId(parts[2]) else { return nil }
        return Parent(traceId: parts[1], spanId: parts[2])
    }

    private static func isLowerHexId(_ id: String, length: Int) -> Bool {
        guard id.count == length else { return false }
        guard id.allSatisfy({ ("0"..."9").contains($0) || ("a"..."f").contains($0) }) else { return false }
        return id.contains { $0 != "0" }
    }

    private static func randomId(bytes: Int, valid: (String) -> Bool) -> String {
        // An all-zero id is invalid; the odds are 2^-64 or less, so a redraw is practically never needed.
        while true {
            let id = (0..<bytes).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
            if valid(id) { return id }
        }
    }
}

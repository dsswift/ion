import Foundation

/// A `desktop_transcript_patch` event: one change to one transcript stream.
///
/// A client applies it only when it holds the stream at exactly `baseRev` in
/// epoch `epoch`. Anything else means it missed a change, and the answer is
/// always the same: take a fresh snapshot. See `TranscriptStream`.
struct TranscriptPatch: Codable, Sendable {
    var streamId: String
    /// The owning conversation. A dispatch stream names its parent tab.
    var tabId: String
    var instanceId: String?
    /// Dispatch streams only: the dispatched conversation and dispatch.
    var conversationId: String?
    var dispatchId: String? = nil
    var epoch: String
    var baseRev: Int
    var rev: Int
    /// Row count of the whole transcript after this change.
    var total: Int
    var change: TranscriptChange
    /// The W3C trace position of the run that produced this change, when the
    /// frame carried one (`trace_id` / `span_id`). The phone's render spans
    /// join that trace; a patch without one is joined to its tab's waiting
    /// prompt instead.
    var traceId: String? = nil
    var spanId: String? = nil
}

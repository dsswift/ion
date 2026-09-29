import Foundation

/// One page of a transcript stream, from a `studio_body` reply.
///
/// `rows[0]` is row `startIndex` of `total` at revision `rev`. `isNewest` says
/// the page is the stream's newest (the reply subscribed this connection to
/// the stream's patches); otherwise it is an older page, prepended.
struct TranscriptPage: Sendable {
    var tabId: String
    var instanceId: String
    /// A dispatched agent's transcript: its conversation and dispatch. Both
    /// nil on a tab's own transcript.
    var conversationId: String? = nil
    var dispatchId: String? = nil
    var streamId: String
    var epoch: String
    var rev: Int
    var total: Int
    var startIndex: Int
    var rows: [Message]
    var hasOlder: Bool
    var isNewest: Bool
}

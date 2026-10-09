import Foundation

/// One page of a transcript stream, from a `studio_body` reply.
///
/// `rows[0]` is row `startIndex` of `total` at revision `rev`. `isNewest` says
/// the page is the stream's newest (the reply subscribed this connection to
/// the stream's patches); otherwise it is an older page, prepended.
///
/// `unchanged` says the server confirmed the revision the phone named in its
/// request is still the stream's current one. Such a page carries no rows and
/// no window (`rows`, `startIndex`, and `hasOlder` mean nothing on it): the
/// rows held stand.
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
    var unchanged: Bool = false
}

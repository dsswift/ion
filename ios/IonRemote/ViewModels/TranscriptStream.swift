import Foundation

/// The phone's copy of one server transcript stream: which stream, at which
/// revision, and which slice of it the phone holds.
///
/// The rows themselves live in the conversation instance's `messages` (the
/// one array the views read); this holds everything needed to keep that array
/// equal to the server's rows. The phone holds a contiguous window
/// `[startIndex, total)`: the newest page, plus any older pages scrolled in.
///
/// The rule is the protocol's (`@ion/shared/transcript/transcript-patch`):
/// apply a patch only when it continues exactly from the revision held;
/// anything else means something was missed, and the only repair is a fresh
/// snapshot. Nothing here guesses or merges.
struct TranscriptStream: Equatable, Sendable {
    var tabId: String
    var instanceId: String
    var streamId: String
    var epoch: String
    var rev: Int
    /// Row count of the whole transcript at `rev`.
    var total: Int
    /// Index in the whole transcript of the first row held.
    var startIndex: Int

    /// Whether rows older than the window exist on the server.
    var hasOlder: Bool { startIndex > 0 }

    /// The revision held, as a newest-page request names it.
    var revision: TranscriptRevision { TranscriptRevision(epoch: epoch, rev: rev) }

    /// What a snapshot, patch, or page did to the stream.
    enum Outcome: Equatable {
        case applied
        /// Nothing to do, and nothing wrong (a patch for a stream being
        /// re-fetched, say).
        case ignored(String)
        /// The phone no longer holds what the server holds. The reason goes
        /// in the log line; the repair is always a fresh newest page.
        case resync(String)
    }

    /// Apply a `studio_body` page.
    ///
    /// A newest page replaces the stream and its rows outright: it is a
    /// complete, consistent point in the stream, whatever was held before.
    /// An older page is prepended only when it provably continues the window:
    /// same stream, same epoch, same revision, and it ends exactly where the
    /// window begins.
    ///
    /// An `unchanged` page confirms the revision held and changes nothing. If
    /// the phone no longer holds that revision, it holds something the server
    /// did not confirm.
    static func apply(page: TranscriptPage, stream: inout TranscriptStream?, rows: inout [Message]) -> Outcome {
        if page.unchanged {
            guard let held = stream, held.streamId == page.streamId, held.epoch == page.epoch, held.rev == page.rev else {
                return .resync("unchanged_not_held")
            }
            return .ignored("unchanged")
        }
        if page.isNewest {
            stream = TranscriptStream(
                tabId: page.tabId, instanceId: page.instanceId, streamId: page.streamId,
                epoch: page.epoch, rev: page.rev, total: page.total, startIndex: page.startIndex
            )
            rows = page.rows
            guard page.startIndex + page.rows.count == page.total else {
                return .resync("page_not_at_end")
            }
            return .applied
        }
        guard var held = stream else { return .resync("older_page_without_stream") }
        guard page.streamId == held.streamId, page.epoch == held.epoch else { return .resync("older_page_other_stream") }
        guard page.rev == held.rev else { return .resync("older_page_stale") }
        guard page.startIndex + page.rows.count == held.startIndex else { return .resync("older_page_not_contiguous") }
        rows.insert(contentsOf: page.rows, at: 0)
        held.startIndex = page.startIndex
        stream = held
        return .applied
    }

    /// Apply one patch. `awaitingSnapshot` is true while a fresh newest page
    /// has been asked for: patches computed before it are superseded by it.
    static func apply(patch: TranscriptPatch, stream: inout TranscriptStream?, rows: inout [Message], awaitingSnapshot: Bool) -> Outcome {
        guard var held = stream else { return .ignored("no_stream") }
        if awaitingSnapshot { return .ignored("awaiting_snapshot") }
        guard patch.streamId == held.streamId else { return .resync("stream_changed") }
        guard patch.epoch == held.epoch else { return .resync("epoch_changed") }
        guard patch.baseRev == held.rev else { return .resync("rev_gap") }

        switch patch.change {
        case .reset(let reason):
            return .resync("reset_\(reason)")
        case .append(let index, let id, let field, let text):
            let local = index - held.startIndex
            guard local >= 0 else { return .resync("below_window") }
            guard local < rows.count, rows[local].id == id else { return .resync("append_mismatch") }
            switch field {
            case .content: rows[local].content += text
            case .toolInput: rows[local].toolInput = (rows[local].toolInput ?? "") + text
            }
        case .splice(let at, let deleteCount, let newRows):
            let local = at - held.startIndex
            guard local >= 0 else { return .resync("below_window") }
            guard deleteCount >= 0, local + deleteCount <= rows.count else { return .resync("splice_out_of_range") }
            rows.replaceSubrange(local..<(local + deleteCount), with: newRows)
        }

        held.rev = patch.rev
        held.total = patch.total
        stream = held
        guard held.startIndex + rows.count == held.total else { return .resync("total_mismatch") }
        return .applied
    }
}

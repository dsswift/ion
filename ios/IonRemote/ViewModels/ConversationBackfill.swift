import Foundation

/// Background completion of a conversation's history after first paint.
///
/// ── What this replaces ──────────────────────────────────────────────────────
/// A conversation opens with its newest page only, and older pages arrived when
/// the user scrolled into them. That made scrolling back a sequence of hitches,
/// and it made a jump to an older row impossible — the page holding that row
/// had never been fetched, so there was no local row to scroll to.
///
/// The first attempt at fixing that walked the page chain one page at a time.
/// It worked, and it was badly wrong in practice: the default page is 10 rows
/// (`PAGE_SIZE`, snapped to a turn boundary), so a 1993-row conversation took
/// ~200 round trips at ~6 requests/second, and EVERY response rebuilt the
/// transcript. The measured result was seconds of continuous flicker on entry
/// and on resume.
///
/// ── Why one bulk request instead ────────────────────────────────────────────
/// The numbers say the walk was never necessary. A measured transcript averages
/// ~1.3 KB per row on the wire after the tool-content cap, so ~2000 rows is
/// ~2.6 MB, and the relay caps a frame at 12 MB. The entire conversation fits
/// in a single frame with room to spare.
///
/// So: the newest page still paints immediately and nothing about first-paint
/// latency changes, then ONE bulk request pulls the remainder. Two renders
/// instead of two hundred, which removes the flicker by construction rather
/// than by tuning a delay.
///
/// A conversation larger than one bulk page (beyond `BULK_PAGE_MESSAGES` on the
/// desktop) simply takes another bulk request — the same loop, but measured in
/// single-digit iterations rather than hundreds.
@MainActor
final class ConversationBackfill {

    /// Rows to request per bulk page.
    ///
    /// Matches the desktop's `BULK_PAGE_MESSAGES` ceiling, which is itself
    /// sized against the relay frame limit. Asking for more is clamped
    /// server-side, so this is the largest useful request.
    static let bulkPageSize = 2000

    /// Hard ceiling on bulk requests for one conversation.
    ///
    /// At 2000 rows each this covers a 20,000-row conversation. It is not a
    /// policy limit — it stops a desktop that reports more history with an
    /// unchanging cursor from looping forever, which is a bug that should
    /// surface as a logged stop rather than an endless request stream.
    private static let maxRequests = 10

    /// Conversations with a bulk request outstanding, so a second history
    /// response cannot start a duplicate.
    private var running: Set<String> = []

    /// Bulk requests issued per conversation in the current pass.
    private var requestCount: [String: Int] = [:]

    /// Conversations already walked to completion, so re-entering a fully
    /// loaded conversation issues nothing.
    private var completed: Set<String> = []

    /// Continue loading a conversation's history.
    ///
    /// Called on every history response. Issues a bulk request for the
    /// remainder when one is warranted, and otherwise does nothing.
    ///
    /// `requestPage` performs the fetch; the caller owns the send so this type
    /// stays free of transport concerns.
    func advance(
        tabId: String,
        hasMore: Bool,
        cursor: String?,
        isLoading: Bool,
        requestPage: (String, Int) -> Void
    ) {
        guard hasMore, let cursor, !cursor.isEmpty else {
            finish(tabId: tabId, reason: "complete")
            return
        }
        guard !completed.contains(tabId) else { return }

        // A request for this conversation is already in flight — the first
        // page, or the previous bulk page. Its response re-enters here.
        guard !isLoading else { return }

        let issued = requestCount[tabId] ?? 0
        if issued >= Self.maxRequests {
            DiagnosticLog.log("conversation backfill stopped at request cap", tag: "session.backfill", level: .warn, fields: [
                "tab_id": String(tabId.prefix(8)),
                "requests": String(issued),
            ])
            finish(tabId: tabId, reason: "request_cap")
            return
        }

        running.insert(tabId)
        requestCount[tabId] = issued + 1
        DiagnosticLog.log("conversation backfill requesting bulk page", tag: "session.backfill", fields: [
            "tab_id": String(tabId.prefix(8)),
            "request": String(issued + 1),
            "page_size": String(Self.bulkPageSize),
        ])
        requestPage(cursor, Self.bulkPageSize)
    }

    /// True while a bulk request is outstanding.
    func isBackfilling(_ tabId: String) -> Bool {
        running.contains(tabId)
    }

    /// Bulk requests issued for this conversation.
    func requestsIssued(_ tabId: String) -> Int {
        requestCount[tabId] ?? 0
    }

    /// True once the conversation is fully local.
    func isComplete(_ tabId: String) -> Bool {
        completed.contains(tabId)
    }

    /// Mark the conversation done, logging how many requests it took.
    ///
    /// The completion line is what answers "was the whole conversation local
    /// when the jump ran?" without another rebuild cycle.
    func finish(tabId: String, reason: String) {
        let wasRunning = running.remove(tabId) != nil
        if reason == "complete" {
            completed.insert(tabId)
        }
        guard wasRunning else { return }
        DiagnosticLog.log("conversation backfill finished", tag: "session.backfill", fields: [
            "tab_id": String(tabId.prefix(8)),
            "requests": String(requestCount[tabId] ?? 0),
            "reason": reason,
        ])
    }

    /// Forget a conversation entirely, so it backfills again on re-entry.
    ///
    /// Called when a transcript is replaced wholesale (a fingerprint heal, or a
    /// reconnect reload): the pages fetched described a transcript that no
    /// longer exists.
    func reset(tabId: String) {
        running.remove(tabId)
        completed.remove(tabId)
        requestCount[tabId] = nil
    }
}

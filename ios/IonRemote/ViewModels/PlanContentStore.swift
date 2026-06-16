import Foundation

// MARK: - PlanContentStore
//
// Assembles paged plan_content events into the full plan body, keyed by
// questionId. Mirrors ResourceStore's content-fetch pattern (resource_content
// response populates a single item); here we accumulate successive 64 KB
// windows until hasMore=false, then mark the fetch complete.
//
// Lifecycle: one store per SessionViewModel. Reset on unpair/device switch.
// The store is @Observable so PlanApprovalCardView can react to completion.

@Observable
final class PlanContentStore {

    // MARK: - Types

    struct FetchState {
        /// Accumulated UTF-8 content. Grows as pages arrive.
        var content: String = ""
        /// True once a page with hasMore=false arrives.
        var complete: Bool = false
        /// True while a fetch is in flight and we haven't seen hasMore=false yet.
        var fetching: Bool = false
        /// Total file size in bytes, as reported by the desktop.
        var totalBytes: Int = 0
        /// True if the last fetch returned empty with totalBytes=0 (file not found).
        var fetchError: Bool = false
        /// tabId that owns this permission entry. Stored so automatic
        /// next-page requests can include tabId without needing the caller
        /// to carry it through the event chain.
        var tabId: String = ""
    }

    // MARK: - State

    /// Content assembled per questionId.
    private(set) var states: [String: FetchState] = [:]

    // MARK: - Access

    /// Returns the full assembled plan content for a questionId, or nil if
    /// the fetch is incomplete.
    func fullContent(for questionId: String) -> String? {
        guard let s = states[questionId], s.complete else { return nil }
        return s.content
    }

    /// Returns true if a fetch is currently in progress (pages arriving but
    /// hasMore=true still pending).
    func isFetching(questionId: String) -> Bool {
        states[questionId]?.fetching ?? false
    }

    /// Returns true once the last page (hasMore=false) has arrived.
    func isComplete(questionId: String) -> Bool {
        states[questionId]?.complete ?? false
    }

    // MARK: - Mutations

    /// Record that a fetch has been initiated for a questionId. Marks the
    /// state as "fetching" so the UI can show a loading indicator. Stores
    /// the tabId so automatic next-page continuation can include it.
    func markFetching(questionId: String, tabId: String) {
        if states[questionId] == nil {
            var s = FetchState()
            s.tabId = tabId
            states[questionId] = s
        } else {
            states[questionId]?.tabId = tabId
        }
        states[questionId]?.fetching = true
        DiagnosticLog.log("PLAN-CONTENT-STORE: markFetching questionId=\(questionId.prefix(12)) tabId=\(tabId.prefix(8))")
    }

    /// The tabId that initiated the fetch, for use in continuation requests.
    func tabId(for questionId: String) -> String {
        states[questionId]?.tabId ?? ""
    }

    /// Apply an arriving plan_content page. Pages must arrive in order;
    /// the store simply appends content so out-of-order delivery would
    /// corrupt the assembled body. The desktop sends pages in order and
    /// iOS requests them sequentially (next page after receiving current
    /// page's hasMore=true), so order is guaranteed.
    func applyPage(questionId: String, content: String, totalBytes: Int, hasMore: Bool) {
        if states[questionId] == nil {
            states[questionId] = FetchState()
        }
        states[questionId]?.content += content
        states[questionId]?.totalBytes = totalBytes
        states[questionId]?.fetchError = (content.isEmpty && totalBytes == 0)
        if !hasMore {
            states[questionId]?.complete = true
            states[questionId]?.fetching = false
            DiagnosticLog.log("PLAN-CONTENT-STORE: complete questionId=\(questionId.prefix(12)) totalBytes=\(totalBytes) contentLen=\(states[questionId]?.content.count ?? 0)")
        } else {
            states[questionId]?.fetching = true
            DiagnosticLog.log("PLAN-CONTENT-STORE: page questionId=\(questionId.prefix(12)) offset=\(states[questionId]?.content.count ?? 0) hasMore=true")
        }
    }

    /// Clear the fetch state for a specific questionId. Called when the
    /// permission card is dismissed so stale content doesn't persist across
    /// different plan approval interactions.
    func clear(questionId: String) {
        states.removeValue(forKey: questionId)
    }

    /// Wipe all state. Called on unpair or device switch.
    func wipe() {
        states = [:]
        DiagnosticLog.log("PLAN-CONTENT-STORE: wiped")
    }
}

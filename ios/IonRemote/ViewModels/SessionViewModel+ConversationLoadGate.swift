import Foundation

// MARK: - Conversation-load gating
//
// One predicate for "does this surface actually need to ask the desktop for
// history?", extracted so the answer is identical everywhere a view appears.
// Lives in its own file because SessionViewModel+Commands.swift sits at
// 574/600 against the Swift cap (CLAUDE.md → "When a file exceeds the cap").
//
// ─── The spinner this removes ───────────────────────────────────────────────
//
// ConversationView used to fire loadConversation from two `.task` blocks that
// both run on first appear, guarded by `engineMsgs.isEmpty`. That guard is
// PERMANENTLY true for a conversation with no messages, so a brand-new tab
// re-requested history on every appear, forever — and asked twice each time.
//
// Those requests were also redundant on arrival. The snapshot pre-load
// (handleSnapshot) has normally already fetched the tab and inserted it into
// `conversationLoaded` before the view is ever pushed, so by the time the view
// appears the transcript is authoritative. The second and third requests keyed
// identically to the first, hit the desktop's 1s coalesce window, and were
// dropped without a response — leaving `loadingConversation` set and the
// "Loading conversation…" spinner on screen until iOS's own 5s retry timer
// fired. On a history-less tab that spinner was pure latency: there was
// nothing to load.
//
// Gating on `conversationLoaded` instead of `engineMsgs.isEmpty` is the precise
// question — "have we ever successfully loaded this tab?" rather than "does it
// happen to render zero rows right now?" — so an empty conversation is
// correctly treated as loaded.
//
// Staleness is NOT this gate's job and is untouched by it: the fingerprint
// reconcile (maybeReconcileStaleConversation) heals a diverged transcript, and
// the reconnect path (ConversationView+InputBar.handleConnectionStateChange)
// reloads after a transport gap. Both call `loadConversation` directly, as do
// the user-initiated retries (the failed-load banner), so an explicit reload is
// never suppressed.

extension SessionViewModel {

    /// Request history for `tabId` only if no load has succeeded and none is in
    /// flight. Used by view-appear paths, which fire on every navigation and
    /// must not re-ask for a transcript the client already holds.
    ///
    /// Explicit reloads (retry button, reconnect heal, staleness reconcile)
    /// bypass this and call `loadConversation` directly — they exist precisely
    /// to re-fetch something already loaded.
    @MainActor
    func loadConversationIfNeeded(tabId: String) {
        if conversationLoaded.contains(tabId) {
            DiagnosticLog.log("load gate: already loaded, skipping", tag: "session.loadgate", fields: [
                "tab_id": String(tabId.prefix(8))
            ])
            return
        }
        if loadingConversation.contains(tabId) {
            DiagnosticLog.log("load gate: load already in flight, skipping", tag: "session.loadgate", fields: [
                "tab_id": String(tabId.prefix(8))
            ])
            return
        }
        DiagnosticLog.log("load gate: fetching history", tag: "session.loadgate", fields: [
            "tab_id": String(tabId.prefix(8))
        ])
        loadConversation(tabId: tabId)
    }

    /// Which in-flight conversation loads a snapshot should re-drive.
    ///
    /// `inFlightBefore` is the `loadingConversation` set captured BEFORE the
    /// snapshot's tab loop ran; `currentlyLoading` is the set as it stands now.
    /// Only the intersection is resent: still in flight, and in flight for
    /// longer than this snapshot.
    ///
    /// The excluded case is the defect this exists to prevent. The tab loop
    /// itself starts loads (`loadConversation` inserts and sends immediately),
    /// so resending the LIVE set re-sent every load the same pass had just put
    /// on the wire — identical tab, identical cursor, same millisecond. The
    /// desktop's coalesce gate keyed them the same, absorbed them as
    /// `coalesced duplicate load … age_ms: 0`, and (before the desktop-side
    /// replay fix) answered neither.
    ///
    /// Pure and static so the distinction is unit-testable without driving a
    /// whole snapshot through the view model.
    static func conversationLoadsToResend(
        inFlightBefore: Set<String>,
        currentlyLoading: Set<String>,
    ) -> Set<String> {
        inFlightBefore.intersection(currentlyLoading)
    }
}

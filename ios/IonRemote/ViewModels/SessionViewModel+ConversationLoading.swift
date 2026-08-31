import Foundation

/// Conversation history loading: initial load, paging, and the retry clock.
///
/// Extracted from SessionViewModel+Commands to keep that file under the
/// 600-line cap, and because these functions form one unit — they share the
/// loading flags, the cursor, and the timer that recovers a dropped response.
///
/// ── The page size these all share ───────────────────────────────────────────
/// Every request here asks for a BULK page. The wire's default page is 10 rows,
/// which is right for a first paint and wrong for everything else: a measured
/// 1993-row conversation took ~200 round trips at that size, and each response
/// rebuilt the transcript. A transcript averages ~1.3 KB per row on the wire
/// after the tool-content cap, so a whole conversation is a few megabytes
/// against a 12 MB relay frame — one request, one apply.
extension SessionViewModel {

    @MainActor
    func loadConversation(tabId: String) {
        guard !loadingConversation.contains(tabId) else { return }
        // Do NOT clear the transcript here. Clearing before the fetch left the
        // conversation blank for the whole round-trip (and indefinitely if the
        // response was dropped). The existing messages stay visible until the
        // replacement page arrives; handleConversationHistory replaces them
        // wholesale on the first page (the response echoes this request's
        // nil cursor as `before == nil`).
        clearLiveText(tabId: tabId)
        conversationLoaded.remove(tabId)
        conversationHasMore.removeValue(forKey: tabId)
        conversationCursor.removeValue(forKey: tabId)
        conversationLoadFailed.remove(tabId)
        loadingConversation.insert(tabId)
        // Ask for the WHOLE conversation in one page.
        //
        // ── Why not a small page plus background backfill ──────────────────
        // The small default page (10 rows) paints fast, but everything after
        // it has to arrive as a PREPEND, and a large prepend is what produced
        // both remaining defects: ~2000 freshly inserted self-sizing rows
        // resolve over many frames, each resolution growing contentSize
        // beneath the viewport, so scrollToBottom's two-pass convergence loses
        // the bottom and the conversation opened partway up — and the same
        // churn was the intermittent flicker.
        //
        // A measured transcript is ~1.3 KB per row on the wire after the
        // tool-content cap, so even a 3400-block conversation is ~4.3 MB
        // against a 12 MB relay frame. One request, one apply, nothing to
        // converge on: the defect class is removed rather than damped.
        //
        // hasMore/cursor still work: a conversation larger than one bulk page
        // pages the remainder exactly as before.
        send(
            .loadConversation(tabId: tabId, before: nil, pageSize: ConversationBackfill.bulkPageSize),
            intent: .automaticEssential
        )
        startLoadTimer(tabId: tabId)
    }

    @MainActor
    func clearConversation(tabId: String) {
        setConversationMessages(tabId: tabId, [])
        conversationLoaded.remove(tabId)
        conversationHasMore.removeValue(forKey: tabId)
        conversationCursor.removeValue(forKey: tabId)
        loadingConversation.remove(tabId)
        cancelLoadTimer(tabId: tabId)
        dismissedRestoredCards = dismissedRestoredCards.filter { !$0.hasPrefix("restored-") }
    }

    func loadMoreMessages(tabId: String) {
        guard !loadingConversation.contains(tabId),
              conversationHasMore[tabId] == true,
              let cursor = conversationCursor[tabId] else { return }
        loadingConversation.insert(tabId)
        // Bulk-sized too: this only runs for a conversation larger than one
        // bulk page, and asking at the small default would mean many small
        // prepends where one large one will do.
        send(
            .loadConversation(tabId: tabId, before: cursor, pageSize: ConversationBackfill.bulkPageSize),
            intent: .automaticEssential
        )
        startLoadTimer(tabId: tabId)
    }

    func startLoadTimer(tabId: String) {
        conversationLoadTimers[tabId]?.cancel()
        conversationLoadTimers[tabId] = Task { @MainActor [weak self] in
            // First load attempt retries faster (5s); the post-retry wait stays
            // at 15s. With commit 1's truncation fix, a 5s first retry makes
            // recovery from any transient failure noticeably quicker.
            let retriesSoFar = self?.conversationLoadRetryCount[tabId] ?? 0
            let waitSeconds = retriesSoFar < 1 ? 5 : 15
            try? await Task.sleep(for: .seconds(waitSeconds))
            guard !Task.isCancelled, let self else { return }
            guard self.loadingConversation.contains(tabId) else { return }
            let retries = self.conversationLoadRetryCount[tabId] ?? 0
            if retries < 1 {
                // First timeout -- retry once
                self.conversationLoadRetryCount[tabId] = retries + 1
                let cursor = self.conversationCursor[tabId]
                // Retry the SAME shape: a retry that silently shrank the page
                // would deliver a different transcript than the request it
                // replaces.
                self.send(
                    .loadConversation(
                        tabId: tabId,
                        before: cursor,
                        pageSize: ConversationBackfill.bulkPageSize
                    ),
                    intent: .automaticEssential
                )
                self.startLoadTimer(tabId: tabId)
            } else {
                // Second timeout -- give up
                self.loadingConversation.remove(tabId)
                self.conversationLoadFailed.insert(tabId)
                self.conversationLoadTimers.removeValue(forKey: tabId)
                self.conversationLoadRetryCount.removeValue(forKey: tabId)
            }
        }
    }

    func cancelLoadTimer(tabId: String) {
        conversationLoadTimers[tabId]?.cancel()
        conversationLoadTimers.removeValue(forKey: tabId)
        conversationLoadRetryCount.removeValue(forKey: tabId)
    }
}

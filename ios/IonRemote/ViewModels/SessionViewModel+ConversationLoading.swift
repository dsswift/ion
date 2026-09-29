import Foundation

/// The retry clock for a conversation's newest transcript page.
///
/// A page request can go unanswered (a relay drop, a connection that died
/// with the request on it). The clock re-asks once, then gives up and shows
/// the failed-load banner, whose retry asks again. It measures the
/// connection's silence, not a request's age: every answer restarts it.
extension SessionViewModel {

    func startLoadTimer(tabId: String) {
        conversationLoadTimers[tabId]?.cancel()
        conversationLoadTimers[tabId] = Task { @MainActor [weak self] in
            // The first wait is short (5s) so a dropped request recovers
            // quickly; the wait after the retry is longer (15s).
            let retriesSoFar = self?.conversationLoadRetryCount[tabId] ?? 0
            let waitSeconds = retriesSoFar < 1 ? 5 : 15
            // Only CancellationError can surface; the guard below re-checks cancellation.
            // swiftlint:disable:next silent_try_optional
            try? await Task.sleep(for: .seconds(waitSeconds))
            guard !Task.isCancelled, let self else { return }
            guard self.loadingConversation.contains(tabId) else { return }
            let retries = self.conversationLoadRetryCount[tabId] ?? 0
            if retries < 1 {
                // First timeout -- retry once
                self.conversationLoadRetryCount[tabId] = retries + 1
                DiagnosticLog.log("transcript page request unanswered, asking again", tag: "transcript", level: .warn, fields: [
                    "tab_id": String(tabId.prefix(16)), "wait_s": String(waitSeconds)
                ])
                self.send(
                    .loadConversation(tabId: tabId, before: nil, pageSize: Self.transcriptPageRows),
                    intent: .automaticEssential
                )
                self.startLoadTimer(tabId: tabId)
            } else {
                // Second timeout -- give up
                DiagnosticLog.log("transcript page request unanswered twice, showing retry", tag: "transcript", level: .warn, fields: [
                    "tab_id": String(tabId.prefix(16))
                ])
                self.transcriptResyncing.remove(tabId)
                self.loadingConversation.remove(tabId)
                self.conversationLoadFailed.insert(tabId)
                self.conversationLoadTimers.removeValue(forKey: tabId)
                self.conversationLoadRetryCount.removeValue(forKey: tabId)
            }
        }
    }

    /// Any page answer proves the connection is delivering. The requests still
    /// pending are queued behind it, not lost: after a reconnect every held
    /// transcript is asked for at once, and over a relay the answers arrive one
    /// after another, so the last ones in line always outlast a clock started
    /// when they were sent. Asking those again doubles the load on the slowest
    /// link. Each pending clock restarts, keeping its retry count, so a request
    /// counts as unanswered only after the connection itself goes quiet.
    func restartPendingLoadTimers() {
        let pending = loadingConversation.filter { conversationLoadTimers[$0] != nil }
        for tabId in pending { startLoadTimer(tabId: tabId) }
    }

    func cancelLoadTimer(tabId: String) {
        conversationLoadTimers[tabId]?.cancel()
        conversationLoadTimers.removeValue(forKey: tabId)
        conversationLoadRetryCount.removeValue(forKey: tabId)
    }
}

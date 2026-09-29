import Foundation

// MARK: - The server's transcript
//
// A conversation's rows come from exactly one place: the server's own store,
// the same rows Studio renders. The phone asks for the newest page (which
// subscribes it to the conversation's transcript stream), then applies each
// `desktop_transcript_patch` the server publishes. This file is the ONLY
// writer of a conversation instance's `messages`.
//
// Nothing here builds a row from an engine event, merges two versions of a
// transcript, or estimates what might be missing. A patch that does not
// continue exactly from the revision held is proof something was missed, and
// the repair is always the same: ask for the newest page again. Every such
// resync is logged at INFO with its reason, so a gap is never silent.
//
// The one thing the phone adds is its own prompt while it is in flight (the
// pending prompt overlay below), because the server has not made that row yet.

extension SessionViewModel {

    /// Rows asked for per page. The server clamps to its own ceiling and to a
    /// byte budget, so this is simply "as much as one frame will carry".
    static let transcriptPageRows = 2000

    // MARK: - Opening and resyncing

    /// Ask for a conversation's newest page, which also subscribes this
    /// connection to its patches.
    ///
    /// Without `force`, a request already in flight is left alone. `force` is
    /// for the cases where the one in flight can no longer be trusted: a
    /// reconnect (it went to a connection that is gone), a detected gap, an
    /// explicit retry.
    @MainActor
    func requestTranscript(tabId: String, reason: String, force: Bool = false) {
        if !force, transcriptResyncing.contains(tabId) {
            DiagnosticLog.log("transcript request already in flight", tag: "transcript", level: .debug, fields: [
                "tab_id": String(tabId.prefix(16)), "reason": reason
            ])
            return
        }
        let held = transcriptStreams[tabId]
        DiagnosticLog.log("transcript resync", tag: "transcript", fields: [
            "tab_id": String(tabId.prefix(16)),
            "reason": reason,
            "stream_id": held?.streamId ?? "",
            "rev": held.map { String($0.rev) } ?? "",
        ])
        transcriptResyncing.insert(tabId)
        transcriptOlderInFlight.remove(tabId)
        loadingConversation.insert(tabId)
        conversationLoadFailed.remove(tabId)
        // A request queued while disconnected is superseded by this one.
        removeEssential(key: "loadConversation:\(tabId)")
        send(.loadConversation(tabId: tabId, before: nil, pageSize: Self.transcriptPageRows), intent: .automaticEssential)
        startLoadTimer(tabId: tabId)
    }

    /// Open a conversation's transcript when the phone does not hold it yet.
    /// View-appear paths call this; it never re-fetches what is held.
    @MainActor
    func loadConversationIfNeeded(tabId: String) {
        guard transcriptStreams[tabId] == nil, !transcriptResyncing.contains(tabId) else { return }
        requestTranscript(tabId: tabId, reason: "open")
    }

    /// An explicit reload: the failed-load banner's retry.
    @MainActor
    func loadConversation(tabId: String) {
        requestTranscript(tabId: tabId, reason: "user_retry", force: true)
    }

    /// Every stream held was subscribed on a connection that is gone. The
    /// server holds no subscription for the new one, so each is fetched anew.
    @MainActor
    func resyncAllTranscripts(reason: String) {
        let tabIds = Set(transcriptStreams.keys).union(transcriptResyncing)
        for tabId in tabIds.sorted() {
            requestTranscript(tabId: tabId, reason: reason, force: true)
        }
    }

    /// Page in the rows older than the window held. Scroll-driven.
    @MainActor
    func loadMoreMessages(tabId: String) {
        guard let stream = transcriptStreams[tabId], stream.hasOlder,
              !transcriptResyncing.contains(tabId), !transcriptOlderInFlight.contains(tabId),
              let firstId = conversationMessages(tabId).first?.id else { return }
        transcriptOlderInFlight.insert(tabId)
        DiagnosticLog.log("transcript older page requested", tag: "transcript", fields: [
            "tab_id": String(tabId.prefix(16)), "stream_id": stream.streamId, "start_index": String(stream.startIndex)
        ])
        send(.loadConversation(tabId: tabId, before: firstId, pageSize: Self.transcriptPageRows), intent: .automaticEssential)
    }

    // MARK: - Applying what the server sends

    @MainActor
    func handleTranscriptPage(_ page: TranscriptPage) {
        let tabId = page.tabId
        if page.isNewest {
            transcriptResyncing.remove(tabId)
            loadingConversation.remove(tabId)
            conversationLoadFailed.remove(tabId)
            cancelLoadTimer(tabId: tabId)
        } else {
            transcriptOlderInFlight.remove(tabId)
        }
        var stream = transcriptStreams[tabId]
        let outcome = withTranscriptRows(tabId: tabId) { rows in
            TranscriptStream.apply(page: page, stream: &stream, rows: &rows)
        }
        transcriptStreams[tabId] = stream
        DiagnosticLog.log("transcript page applied", tag: "transcript", fields: [
            "tab_id": String(tabId.prefix(16)),
            "stream_id": page.streamId,
            "rev": String(page.rev),
            "rows": String(page.rows.count),
            "start_index": String(page.startIndex),
            "total": String(page.total),
            "newest": String(page.isNewest),
            "outcome": String(describing: outcome),
        ])
        settle(outcome, tabId: tabId)
        restartPendingLoadTimers()
    }

    /// The server's page reply gave no usable page. With no stream (the
    /// conversation has no instance yet, or this connection may not read it)
    /// there is nothing to show and nothing to retry; a page that did not
    /// decode is a failure, and the view offers a retry.
    @MainActor
    func handleTranscriptUnavailable(tabId: String, isNewest: Bool, reason: String) {
        DiagnosticLog.log("transcript unavailable", tag: "transcript", level: .warn, fields: [
            "tab_id": String(tabId.prefix(16)), "newest": String(isNewest), "reason": reason
        ])
        if isNewest {
            transcriptResyncing.remove(tabId)
            loadingConversation.remove(tabId)
            cancelLoadTimer(tabId: tabId)
            if reason != "no_stream" { conversationLoadFailed.insert(tabId) }
        } else {
            transcriptOlderInFlight.remove(tabId)
        }
        restartPendingLoadTimers()
    }

    @MainActor
    func handleTranscriptPatch(_ patch: TranscriptPatch) {
        let tabId = patch.tabId
        var stream = transcriptStreams[tabId]
        let awaiting = transcriptResyncing.contains(tabId)
        let outcome = withTranscriptRows(tabId: tabId) { rows in
            TranscriptStream.apply(patch: patch, stream: &stream, rows: &rows, awaitingSnapshot: awaiting)
        }
        transcriptStreams[tabId] = stream
        switch outcome {
        case .applied:
            DiagnosticLog.trace("transcript patch applied", tag: "transcript", fields: [
                "tab_id": String(tabId.prefix(16)), "rev": String(patch.rev), "kind": patch.change.kindName
            ])
        case .ignored(let why):
            DiagnosticLog.log("transcript patch ignored", tag: "transcript", level: .debug, fields: [
                "tab_id": String(tabId.prefix(16)), "stream_id": patch.streamId, "rev": String(patch.rev), "reason": why
            ])
        case .resync:
            DiagnosticLog.log("transcript patch did not apply", tag: "transcript", fields: [
                "tab_id": String(tabId.prefix(16)),
                "stream_id": patch.streamId,
                "base_rev": String(patch.baseRev),
                "held_rev": stream.map { String($0.rev) } ?? "",
                "kind": patch.change.kindName,
            ])
        }
        settle(outcome, tabId: tabId)
    }

    /// After the phone's rows changed: follow a resync outcome, and bring
    /// everything that reads the rows up to date.
    @MainActor
    private func settle(_ outcome: TranscriptStream.Outcome, tabId: String) {
        switch outcome {
        case .resync(let reason):
            requestTranscript(tabId: tabId, reason: reason, force: true)
        case .applied:
            transcriptRowsChanged(tabId: tabId)
        case .ignored:
            break
        }
    }

    /// Check the rows held still match the stream after something other than
    /// this file replaced the conversation instance (a snapshot that brought a
    /// new instance). A mismatch means the rows are gone from where the views
    /// read them.
    @MainActor
    func verifyTranscriptWindow(tabId: String) {
        guard let stream = transcriptStreams[tabId], !transcriptResyncing.contains(tabId),
              let instance = conversationInstances[tabId]?.first else { return }
        if instance.id != stream.instanceId {
            requestTranscript(tabId: tabId, reason: "instance_changed", force: true)
        } else if stream.startIndex + instance.messages.count != stream.total {
            requestTranscript(tabId: tabId, reason: "window_lost", force: true)
        }
    }

    /// Forget everything held for a conversation (it closed), its
    /// dispatches' transcripts included.
    @MainActor
    func forgetTranscript(tabId: String) {
        for (key, owner) in dispatchTabs where owner == tabId {
            dispatchTabs.removeValue(forKey: key)
            dispatchStreams.removeValue(forKey: key)
            dispatchResyncing.remove(key)
            agentConversationMessages.removeValue(forKey: key)
            agentConversationLoading.remove(key)
        }
        transcriptStreams.removeValue(forKey: tabId)
        transcriptResyncing.remove(tabId)
        transcriptOlderInFlight.remove(tabId)
        pendingPrompts.removeValue(forKey: tabId)
        loadingConversation.remove(tabId)
        conversationLoadFailed.remove(tabId)
        cancelLoadTimer(tabId: tabId)
    }

    /// Run `body` on the conversation's rows in place. The single write seam.
    @MainActor
    private func withTranscriptRows(tabId: String, _ body: (inout [Message]) -> TranscriptStream.Outcome) -> TranscriptStream.Outcome {
        ensureMainInstance(tabId: tabId)
        guard conversationInstances[tabId]?.isEmpty == false else { return .ignored("no_instance") }
        return body(&conversationInstances[tabId]![0].messages)
    }

    // MARK: - Reading the rows

    /// A conversation's rows as the views show them: the server's transcript,
    /// then this phone's prompts the server has not made rows for yet.
    @MainActor
    func renderedMessages(tabId: String) -> [Message] {
        let rows = conversationMessages(tabId)
        guard let pending = pendingPrompts[tabId], !pending.isEmpty else { return rows }
        return rows + pending
    }

    /// Bring everything derived from the rows up to date.
    @MainActor
    private func transcriptRowsChanged(tabId: String) {
        let rows = conversationMessages(tabId)
        settlePendingPrompts(tabId: tabId, rows: rows)
        deriveActiveTools(tabId: tabId, rows: rows)
    }

    /// The tools the status drawer lists as running: the transcript's running
    /// tool rows, while the conversation runs. Stall marks survive because
    /// they arrive on their own event.
    @MainActor
    func deriveActiveTools(tabId: String, rows: [Message]? = nil) {
        let status = tabs.first(where: { $0.id == tabId })?.status
        guard status == .running || status == .connecting else {
            activeTools.removeValue(forKey: tabId)
            return
        }
        let previous = activeTools[tabId] ?? [:]
        var tools: [String: ActiveToolInfo] = [:]
        for row in rows ?? conversationMessages(tabId) where row.role == .tool && row.toolStatus == .running {
            let toolId = row.toolId ?? row.id
            var info = ActiveToolInfo(
                id: toolId,
                toolName: row.toolName ?? "",
                startTime: Date(timeIntervalSince1970: (row.timestamp ?? 0) / 1000)
            )
            info.isStalled = previous[toolId]?.isStalled ?? false
            tools[toolId] = info
        }
        if tools.isEmpty {
            activeTools.removeValue(forKey: tabId)
        } else {
            activeTools[tabId] = tools
        }
    }
}

import Foundation

// MARK: - Dispatched agents' transcripts
//
// A dispatched agent's transcript is the server's too: the rows Studio shows
// for that dispatch (its conversation file with the dispatch's in-flight
// activity on top), published as a transcript stream of its own. The phone
// asks for a dispatch's newest page, which subscribes it, and applies the
// patches that follow -- the same rule as a tab's transcript
// (TranscriptStream): a patch that does not continue exactly from the
// revision held means a newest page is fetched again.
//
// A dispatch is bounded, and the phone holds all of it: when a page leaves
// older rows behind, the next older page is asked for at once, until the
// window reaches the first row. Every previous dispatch can then be reviewed
// in full, nested dispatches included, since each is its own stream.
//
// Rows land in `agentConversationMessages` under `dispatchKey`, the one place
// the agent views read them. An agent with no registered dispatch owns
// conversations through its own metadata; its rows are the concatenation of
// those conversations' streams, kept under the agent's name.

extension SessionViewModel {

    /// The key a dispatch's rows, stream, and loading flag are kept under.
    static func dispatchKey(conversationId: String, dispatchId: String) -> String {
        "\(conversationId):\(dispatchId)"
    }

    // MARK: - Opening

    /// Open a dispatch's transcript unless it is already held or on its way.
    @MainActor
    func loadAgentDispatchConversation(tabId: String, dispatch: DispatchInfo) {
        openDispatchTranscript(tabId: tabId, conversationId: dispatch.conversationId, dispatchId: dispatch.id)
    }

    /// Open a dispatch's transcript by its ids, unless it is already held or
    /// on its way.
    @MainActor
    func openDispatchTranscript(tabId: String, conversationId: String, dispatchId: String) {
        guard !conversationId.isEmpty else { return }
        let key = Self.dispatchKey(conversationId: conversationId, dispatchId: dispatchId)
        guard dispatchStreams[key] == nil, !dispatchResyncing.contains(key) else { return }
        requestDispatchTranscript(tabId: tabId, conversationId: conversationId, dispatchId: dispatchId, reason: "open")
    }

    /// Open every other dispatch of `agent` in the background, so switching
    /// between them is instant.
    @MainActor
    func preloadAgentDispatches(tabId: String, agent: AgentStateUpdate, excluding conversationId: String) {
        for dispatch in agent.dispatches where dispatch.conversationId != conversationId {
            loadAgentDispatchConversation(tabId: tabId, dispatch: dispatch)
        }
    }

    /// Open the conversations an agent with no registered dispatch owns; its
    /// rows are theirs, in order, under the agent's name.
    @MainActor
    func loadAgentConversation(tabId: String, agent: AgentStateUpdate) {
        guard !agent.conversationIds.isEmpty else { return }
        agentConversationGroups[agent.name] = agent.conversationIds.map { Self.dispatchKey(conversationId: $0, dispatchId: "") }
        for conversationId in agent.conversationIds {
            let key = Self.dispatchKey(conversationId: conversationId, dispatchId: "")
            guard dispatchStreams[key] == nil, !dispatchResyncing.contains(key) else { continue }
            requestDispatchTranscript(tabId: tabId, conversationId: conversationId, dispatchId: "", reason: "open")
        }
        refreshAgentConversationGroups()
    }

    /// Ask for a dispatch's newest page (which subscribes to its patches).
    @MainActor
    func requestDispatchTranscript(tabId: String, conversationId: String, dispatchId: String, reason: String, force: Bool = false) {
        let key = Self.dispatchKey(conversationId: conversationId, dispatchId: dispatchId)
        if !force, dispatchResyncing.contains(key) { return }
        DiagnosticLog.log("dispatch transcript resync", tag: "transcript.dispatch", fields: [
            "tab_id": String(tabId.prefix(16)),
            "conversation_id": conversationId,
            "dispatch_id": dispatchId,
            "reason": reason,
            "rev": dispatchStreams[key].map { String($0.rev) } ?? "",
        ])
        dispatchTabs[key] = tabId
        dispatchResyncing.insert(key)
        agentConversationLoading.insert(key)
        removeEssential(key: "loadDispatchTranscript:\(key)")
        send(.loadDispatchTranscript(tabId: tabId, conversationId: conversationId, dispatchId: dispatchId, before: nil, pageSize: Self.transcriptPageRows), intent: .automaticEssential)
    }

    /// Every dispatch stream was subscribed on a connection that is gone.
    @MainActor
    func resyncAllDispatchTranscripts(reason: String) {
        for key in Set(dispatchStreams.keys).union(dispatchResyncing).sorted() {
            guard let tabId = dispatchTabs[key], let (conversationId, dispatchId) = Self.splitDispatchKey(key) else { continue }
            requestDispatchTranscript(tabId: tabId, conversationId: conversationId, dispatchId: dispatchId, reason: reason, force: true)
        }
    }

    // MARK: - Applying what the server sends

    @MainActor
    func handleDispatchTranscriptPage(_ page: TranscriptPage) {
        guard let conversationId = page.conversationId else { return }
        let key = Self.dispatchKey(conversationId: conversationId, dispatchId: page.dispatchId ?? "")
        if page.isNewest {
            dispatchResyncing.remove(key)
            agentConversationLoading.remove(key)
        }
        var stream = dispatchStreams[key]
        let outcome = TranscriptStream.apply(page: page, stream: &stream, rows: &agentConversationMessages[key, default: []])
        dispatchStreams[key] = stream
        DiagnosticLog.log("dispatch transcript page applied", tag: "transcript.dispatch", fields: [
            "conversation_id": conversationId,
            "dispatch_id": page.dispatchId ?? "",
            "rev": String(page.rev),
            "rows": String(page.rows.count),
            "start_index": String(page.startIndex),
            "total": String(page.total),
            "newest": String(page.isNewest),
            "outcome": String(describing: outcome),
        ])
        settleDispatch(outcome, key: key)
        if case .applied = outcome, let held = stream, held.hasOlder, let firstId = agentConversationMessages[key]?.first?.id {
            // A dispatch is held whole: fetch the page before this one now.
            DiagnosticLog.log("dispatch transcript older page requested", tag: "transcript.dispatch", fields: [
                "conversation_id": conversationId, "start_index": String(held.startIndex)
            ])
            send(.loadDispatchTranscript(tabId: held.tabId, conversationId: conversationId, dispatchId: page.dispatchId ?? "", before: firstId, pageSize: Self.transcriptPageRows), intent: .automaticEssential)
        }
    }

    @MainActor
    func handleDispatchTranscriptPatch(_ patch: TranscriptPatch) {
        guard let conversationId = patch.conversationId else { return }
        let key = Self.dispatchKey(conversationId: conversationId, dispatchId: patch.dispatchId ?? "")
        guard dispatchStreams[key] != nil else {
            DiagnosticLog.log("dispatch transcript patch for a stream not held, ignored", tag: "transcript.dispatch", level: .debug, fields: [
                "stream_id": patch.streamId
            ])
            return
        }
        var stream = dispatchStreams[key]
        let awaiting = dispatchResyncing.contains(key)
        let outcome = TranscriptStream.apply(patch: patch, stream: &stream, rows: &agentConversationMessages[key, default: []], awaitingSnapshot: awaiting)
        dispatchStreams[key] = stream
        if case .resync = outcome {
            DiagnosticLog.log("dispatch transcript patch did not apply", tag: "transcript.dispatch", fields: [
                "stream_id": patch.streamId, "base_rev": String(patch.baseRev), "held_rev": stream.map { String($0.rev) } ?? "",
            ])
        }
        settleDispatch(outcome, key: key)
    }

    @MainActor
    func handleDispatchTranscriptUnavailable(conversationId: String, dispatchId: String, isNewest: Bool, reason: String) {
        let key = Self.dispatchKey(conversationId: conversationId, dispatchId: dispatchId)
        DiagnosticLog.log("dispatch transcript unavailable", tag: "transcript.dispatch", level: .warn, fields: [
            "conversation_id": conversationId, "dispatch_id": dispatchId, "newest": String(isNewest), "reason": reason
        ])
        if isNewest {
            dispatchResyncing.remove(key)
            agentConversationLoading.remove(key)
        }
    }

    @MainActor
    private func settleDispatch(_ outcome: TranscriptStream.Outcome, key: String) {
        switch outcome {
        case .resync(let reason):
            guard let tabId = dispatchTabs[key], let (conversationId, dispatchId) = Self.splitDispatchKey(key) else { return }
            requestDispatchTranscript(tabId: tabId, conversationId: conversationId, dispatchId: dispatchId, reason: reason, force: true)
        case .applied:
            refreshAgentConversationGroups()
        case .ignored:
            break
        }
    }

    /// Rebuild the rows of every agent whose transcript is the concatenation
    /// of conversations it owns without a registered dispatch.
    @MainActor
    private func refreshAgentConversationGroups() {
        for (agentName, keys) in agentConversationGroups {
            agentConversationMessages[agentName] = keys.flatMap { agentConversationMessages[$0] ?? [] }
            if keys.contains(where: { dispatchResyncing.contains($0) }) {
                agentConversationLoading.insert(agentName)
            } else {
                agentConversationLoading.remove(agentName)
            }
        }
    }

    /// The conversation and dispatch a key names. Conversation ids hold no
    /// colon; the dispatch id is whatever follows the first one.
    static func splitDispatchKey(_ key: String) -> (String, String)? {
        guard let colon = key.firstIndex(of: ":") else { return nil }
        return (String(key[..<colon]), String(key[key.index(after: colon)...]))
    }
}

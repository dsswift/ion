import Foundation

// MARK: - Agent conversation history, refresh, and diagnostics
//
// Extracted from SessionViewModel+EngineEvents.swift to keep that file under
// the Swift 600-line cap (the user_turn_persisted re-key handler pushed it
// over). This block is a cohesive seam: the agent-conversation history
// snapshot/refresh path plus the diagnostic-log request handler — none of it
// touches the live streaming handlers that remain in the sibling file.

extension SessionViewModel {

    // MARK: - Agent conversation history

    @MainActor
    func handleAgentConversationHistory(agentName: String, conversationId: String?, messages: [Message]) {
        // Assign stable unique IDs before filtering. The relay wire sends id:""
        // for every user/assistant message (engine SessionMessage has no id field).
        // Without this step, all user/assistant DispatchItems share id="" in
        // ForEach, producing SwiftUI identity collisions and duplicated bubbles.
        // Mirrors mapConversationMessages in desktop/agent-conversation-mapper.ts.
        let mapped = assignStableIds(messages)
        let filtered = mapped.filter { $0.isInternal != true }
        // When a conversationId is present (single-dispatch load), cache
        // under that key so each dispatch is cached independently.
        if let convId = conversationId, !convId.isEmpty {
            let wasAlreadyCached = agentSnapshotByConvId[convId] != nil
            DiagnosticLog.log("agent conversation history", tag: "session.engine", fields: [
                "agent": agentName,
                "conversation_id": convId,
                "count": String(messages.count),
                "max": String(filtered.count),
                "reason": wasAlreadyCached ? "replace" : "first-populate"
            ])
            // The file-backed load is the snapshot AUTHORITY — store it and
            // recompute the merged transcript so it replaces stale state while
            // any in-flight push entries newer than the snapshot survive.
            agentSnapshotByConvId[convId] = filtered
            // Resolve the active dispatchAgentId for this convId so
            // recomputeDispatchTranscript reads the right push buffer.
            // Falls back to "" when no push events have arrived yet
            // (push buffer is empty; snapshot-only path is taken).
            let activeDispatchId = activeDispatchIdByConvId[convId] ?? ""
            recomputeDispatchTranscript(dispatchAgentId: activeDispatchId, convId: convId)
            agentConversationLoading.remove(convId)
        } else {
            // Legacy fallback: store under agent name for multi-convId loads
            DiagnosticLog.log("agent conversation history legacy", tag: "session.engine", fields: [
                "agent": agentName,
                "count": String(messages.count),
                "max": String(filtered.count)
            ])
            agentConversationMessages[agentName] = filtered
            agentConversationLoading.remove(agentName)
        }
    }

    // handleDispatchActivity and recomputeDispatchTranscript live in
    // SessionViewModel+DispatchTranscript.swift to keep this file under
    // the 600-line cap. They own the per-dispatch push-buffer fold and
    // snapshot-merge logic; call sites here (handleAgentConversationHistory)
    // call them by name — no API change.

    @MainActor
    func loadAgentConversation(agent: AgentStateUpdate) {
        guard !agent.conversationIds.isEmpty else { return }
        guard !agentConversationLoading.contains(agent.name) else { return }
        DiagnosticLog.log("loading agent conversation", tag: "session.engine", fields: [
            "agent": agent.name,
            "conversation_id": agent.conversationIds.joined(separator: ",")
        ])
        agentConversationLoading.insert(agent.name)
        send(.loadAgentConversation(conversationIds: agent.conversationIds), intent: .automaticEssential)
    }

    /// Load a single dispatch's conversation by conversationId.
    ///
    /// Skip logic:
    ///   - Always skip when a load is already in-flight (prevents duplicate requests).
    ///   - Skip when terminal AND agentSnapshotByConvId[convId] is present — the
    ///     file-backed authority is already cached; no network round-trip needed.
    ///   - Allow load when terminal AND agentSnapshotByConvId[convId] is nil —
    ///     the snapshot was never fetched (e.g. popup never opened), so a load is
    ///     required to populate the authority before the popup can render.
    ///   - Allow reload when still running — the cache may hold stale push-only
    ///     state; a fresh file-backed load heals duplicates on reopen.
    @MainActor
    func loadAgentDispatchConversation(agent: AgentStateUpdate, conversationId: String) {
        guard !conversationId.isEmpty else { return }
        // Never pile on an already-in-flight request.
        guard !agentConversationLoading.contains(conversationId) else { return }
        let dispatch = agent.dispatches.first { $0.conversationId == conversationId }
        let isTerminal = dispatch.map { $0.status == "done" || $0.status == "error" } ?? false
        if isTerminal {
            if agentSnapshotByConvId[conversationId] != nil {
                // Authority already cached — no load needed.
                DiagnosticLog.log("ENGINE: skip load dispatch conv (terminal+snapshot-cached) agent=\(agent.name) convId=\(conversationId)")
                return
            }
            // Terminal but no snapshot yet — allow the load so the authority populates.
            DiagnosticLog.log("ENGINE: load dispatch conv (terminal+snapshot-missing) agent=\(agent.name) convId=\(conversationId)")
        } else if agentConversationMessages[conversationId] != nil {
            // Running dispatch with cached data — allow reload so a reopened
            // popup gets a fresh snapshot rather than stale push-only entries.
            DiagnosticLog.log("ENGINE: reload dispatch conv (running+cached) agent=\(agent.name) convId=\(conversationId) existingMsgCount=\(agentConversationMessages[conversationId]?.count ?? 0)")
        }
        DiagnosticLog.log("loading dispatch conversation", tag: "session.engine", fields: [
            "agent": agent.name,
            "conversation_id": conversationId
        ])
        agentConversationLoading.insert(conversationId)
        send(.loadAgentConversation(conversationIds: [conversationId]), intent: .automaticEssential)
    }

    /// Preload remaining dispatch conversations in the background after
    /// the selected dispatch has loaded. Each fires independently so
    /// switching pills is instant once preloading finishes.
    @MainActor
    func preloadAgentDispatches(agent: AgentStateUpdate, excluding conversationId: String) {
        for d in agent.dispatches {
            let convId = d.conversationId
            guard !convId.isEmpty, convId != conversationId else { continue }
            guard agentConversationMessages[convId] == nil else { continue }
            guard !agentConversationLoading.contains(convId) else { continue }
            loadAgentDispatchConversation(agent: agent, conversationId: convId)
        }
    }

    // MARK: - Agent conversation refresh (force re-fetch)

    /// Re-fetches the file-backed snapshot for a dispatch (the slow reconcile
    /// backstop). The response handler replaces the snapshot authority via
    /// recomputeDispatchTranscript, healing any gap from a dropped push delta
    /// while preserving in-flight push entries. No cache clear — clearing the
    /// merged map would flicker the popup to empty between request and response.
    @MainActor
    func refreshAgentDispatchConversation(agent: AgentStateUpdate, conversationId: String) {
        guard !conversationId.isEmpty else { return }
        guard !agentConversationLoading.contains(conversationId) else { return }
        DiagnosticLog.log("refresh dispatch conversation", tag: "session.engine", fields: [
            "agent": agent.name,
            "conversation_id": conversationId
        ])
        agentConversationLoading.insert(conversationId)
        send(.loadAgentConversation(conversationIds: [conversationId]), intent: .automaticEssential)
    }

    /// Invalidates and re-fetches all conversation data for an agent.
    @MainActor
    func refreshAgentConversation(agent: AgentStateUpdate) {
        guard !agent.conversationIds.isEmpty else { return }
        guard !agentConversationLoading.contains(agent.name) else { return }
        DiagnosticLog.log("refresh agent conversation", tag: "session.engine", fields: [
            "agent": agent.name,
            "conversation_id": agent.conversationIds.joined(separator: ",")
        ])
        agentConversationMessages.removeValue(forKey: agent.name)
        agentConversationLoading.insert(agent.name)
        send(.loadAgentConversation(conversationIds: agent.conversationIds), intent: .automaticEssential)
    }

    // MARK: - Diagnostic log request

    @MainActor
    func handleRequestDiagnosticLogs(sinceSeq: Int = 0) {
        // One uniform path: sinceSeq=0 (full pull) filters seq > 0, which is
        // every line, so there is no special-case export branch. nextSeq is the
        // cursor the desktop persists and echoes on the next request.
        let (logs, nextSeq) = DiagnosticLog.exportIncrementalSince(sinceSeq: sinceSeq)
        // pairingId is the ECDH channel ID — it identifies which desktop pairing
        // collected these logs (the desktop → iOS wire identity). The stable
        // per-device hardware identity (device_id) is stamped directly on every
        // log line by iOS; it does not need to cross the wire separately.
        let pairingId = activeDeviceId ?? "unknown"
        DiagnosticLog.log("diagnostic export", tag: "session", level: .debug, fields: [
            "since_seq": String(sinceSeq),
            "next_seq": String(nextSeq)
        ])
        send(.diagnosticLogsResponse(logs: logs, pairingId: pairingId, nextSeq: nextSeq), intent: .automaticEssential)
    }

    // MARK: - Dispatch terminal cleanup
    // clearTerminalDispatchCaches is in SessionViewModel+DispatchCacheInvalidation.swift,
    // which owns all dispatch cache invalidation logic (Fix A + Fix B).
}

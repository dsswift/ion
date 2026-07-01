import Foundation
import UIKit

// MARK: - Engine Event Handlers

extension SessionViewModel {

    @MainActor
    func handleEngineIntercept(tabId: String, instanceId: String?, level: String, title: String, message: String) {
        // Render the intercept inline in the engine conversation scrollback
        // so the user can see that an extension fired an intercept, what it
        // said, and whether the run was redirected. Uses role: .harness so
        // EngineMessageRow routes it through the intercept banner style.
        // `interceptLevel` on the Message lets the view choose visual weight:
        //   "redirect" — amber/urgent (run was aborted + re-prompted by desktop)
        //   "banner"   — lighter informational style
        //
        // Content format mirrors the desktop: bold title line prefixed with
        // "Conversation redirected: " for redirect level, then the body.
        DiagnosticLog.log("ENGINE: intercept tabId=\(tabId.prefix(8)) level=\(level) title=\(title.prefix(60))")
        let levelPrefix = level == "redirect" ? "Conversation redirected: " : ""
        let content = "**\(levelPrefix)\(title)**\n\n\(message)"
        var msg = Message(
            id: UUID().uuidString,
            role: .harness,
            content: content,
            timestamp: Date().timeIntervalSince1970 * 1000
        )
        msg.interceptLevel = level
        mutateEngineInstance(tabId: tabId, instanceId: instanceId) { $0.messages.append(msg) }
    }

    @MainActor
    func handleEngineHarnessMessage(tabId: String, instanceId: String?, message: String) {
        // Divider messages (session-start, implement, etc.) may be relayed
        // from the desktop as engine_harness_message. Detect the `──` sentinel
        // prefix and create a system-role message so they render with the
        // proper divider visual treatment instead of the harness gear icon.
        let role: MessageRole = message.hasPrefix("──") ? .system : .harness
        let msg = Message(id: UUID().uuidString, role: role, content: message, timestamp: Date().timeIntervalSince1970 * 1000)
        mutateEngineInstance(tabId: tabId, instanceId: instanceId) { $0.messages.append(msg) }
    }

    @MainActor
    func handleEnginePlanModeChanged(tabId: String, instanceId: String?, planModeEnabled: Bool, planFilePath: String?, planSlug: String?) {
        // Plan-mode ENTRY no longer draws a divider. Entry happens before the
        // model has written the plan file, so a marker here would be
        // mispositioned (before any narrative) and its link would not resolve
        // (the file does not exist yet). The divider is now driven by
        // engine_plan_file_written (the actual write) — see
        // handleEnginePlanFileWritten. iOS keeps no plan-mode state of its own
        // here today, so this is an observe-only no-op; the guard documents the
        // proposal (enabled=false) case explicitly.
        guard planModeEnabled else { return }
        _ = (planFilePath, planSlug, instanceId, tabId)
    }

    @MainActor
    func handleEnginePlanFileWritten(tabId: String, instanceId: String?, operation: String, planFilePath: String?, planSlug: String?) {
        // The engine confirmed a Write/Edit landed on the canonical plan file.
        // This is the accurate point to insert the plan-lifecycle divider: the
        // file now exists with content, so the marker is correctly positioned
        // (right after the model's narrative + the write) and the slug link
        // resolves. The engine carries the created-vs-updated discriminator
        // (operation) because only it can observe the file's prior state.
        let slug = planSlug ?? ""
        let time = Date()
        let formatter = DateFormatter()
        formatter.dateFormat = "h:mm a"
        let timeStr = formatter.string(from: time)
        let label = operation == "updated" ? "Plan updated" : "Plan created"
        let content = slug.isEmpty
            ? "── \(label) at \(timeStr) ──"
            : "── \(label) at \(timeStr) · \(slug) ──"
        var msg = Message(id: UUID().uuidString, role: .system, content: content, timestamp: time.timeIntervalSince1970 * 1000)
        // Carry the plan path so the divider row can make the slug a tappable
        // link that opens the plan preview. Empty path stays nil (no link).
        let path = planFilePath ?? ""
        msg.planFilePath = path.isEmpty ? nil : path
        mutateEngineInstance(tabId: tabId, instanceId: instanceId) { $0.messages.append(msg) }
    }

    @MainActor
    func handleEngineSteerInjected(tabId: String, instanceId: String?, messageLength: Int) {
        // Engine drained a mid-turn steer into the conversation. Mirror
        // the desktop's "Steer applied" divider so the user sees
        // confirmation across both clients. messageLength is included so
        // the user can tell a short nudge from a long steer at a glance.
        // The engine may emit this multiple times per turn (between
        // turns, before end_turn exit, after tool results); each capture
        // produces its own divider so the count is visible.
        let time = Date()
        let formatter = DateFormatter()
        formatter.dateFormat = "h:mm a"
        let timeStr = formatter.string(from: time)
        let content = "── Steer applied at \(timeStr) · \(messageLength) chars ──"
        let msg = Message(id: UUID().uuidString, role: .system, content: content, timestamp: time.timeIntervalSince1970 * 1000)
        mutateEngineInstance(tabId: tabId, instanceId: instanceId) { $0.messages.append(msg) }
    }

    @MainActor
    func handleEngineToolStart(tabId: String, instanceId: String?, toolName: String, toolId: String) {
        DiagnosticLog.log("ENGINE: tool-start tabId=\(tabId.prefix(8)) tool=\(toolName) toolId=\(toolId.prefix(8))")
        let info = ActiveToolInfo(id: toolId, toolName: toolName, startTime: Date())
        activeTools[tabId, default: [:]][toolId] = info
        // Add tool message to conversation
        let msg = Message(id: toolId, role: .tool, content: "", toolName: toolName, toolId: toolId, toolStatus: .running, timestamp: Date().timeIntervalSince1970 * 1000)
        mutateEngineInstance(tabId: tabId, instanceId: instanceId) { $0.messages.append(msg) }
    }

    @MainActor
    func handleEngineToolEnd(tabId: String, instanceId: String?, toolId: String, result: String?, isError: Bool) {
        DiagnosticLog.log("ENGINE: tool-end tabId=\(tabId.prefix(8)) toolId=\(toolId.prefix(8)) isError=\(isError)")
        activeTools[tabId]?[toolId] = nil
        if activeTools[tabId]?.isEmpty == true {
            activeTools.removeValue(forKey: tabId)
        }
        // Update tool message status in conversation
        mutateEngineInstance(tabId: tabId, instanceId: instanceId) { inst in
            if let idx = inst.messages.lastIndex(where: { $0.toolId == toolId }) {
                inst.messages[idx].toolStatus = isError ? .error : .completed
                if let result { inst.messages[idx].content = result }
            }
        }
    }

    @MainActor
    func handleEngineError(tabId: String, instanceId: String?, message: String) {
        DiagnosticLog.log("ENGINE: error tabId=\(tabId.prefix(8)) msg=\(message.prefix(80))")
        // Add error as system message in conversation
        let msg = Message(id: UUID().uuidString, role: .system, content: "Error: \(message)", timestamp: Date().timeIntervalSince1970 * 1000)
        mutateEngineInstance(tabId: tabId, instanceId: instanceId) { $0.messages.append(msg) }
        // Reset tab to idle so user can retry
        let isActive = activeEngineInstance[tabId] == instanceId || (instanceId == nil)
        if isActive, let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            tabs[idx].status = .idle
        }
    }

    @MainActor
    func handleEngineNotify(tabId: String, instanceId: String?, message: String, level: String?) {
        DiagnosticLog.log("ENGINE: notify tabId=\(tabId.prefix(8)) level=\(level ?? "info") msg=\(message.prefix(60))")
        // Surface notifications as system messages in the conversation
        let prefix = level == "warning" ? "⚠️ " : level == "error" ? "❌ " : ""
        let msg = Message(id: UUID().uuidString, role: .system, content: "\(prefix)\(message)", timestamp: Date().timeIntervalSince1970 * 1000)
        mutateEngineInstance(tabId: tabId, instanceId: instanceId) { $0.messages.append(msg) }
    }

    @MainActor
    func handleEngineTextDelta(tabId: String, instanceId: String?, text: String) {
        mutateEngineInstance(tabId: tabId, instanceId: instanceId) { inst in
            if let last = inst.messages.last, last.role == .assistant {
                // Append to the existing assistant row whether it is sealed or not.
                // A sealed last-assistant row means a late text delta arrived after
                // engine_message_end (the FIFO race fixed in event-wiring.ts), OR
                // the timer flush fired marginally after the seal event despite the
                // pre-send flush. Either way the text belongs to the same turn.
                // Only a NON-assistant trailing message (e.g. a tool row) signals
                // a genuine new turn where a fresh assistant row is appropriate.
                inst.messages[inst.messages.count - 1].content += text
                // Unseal so subsequent deltas for this run keep appending.
                if inst.messages[inst.messages.count - 1].sealed {
                    DiagnosticLog.log("ENGINE: text-delta after seal tabId=\(tabId.prefix(8)) len=\(text.count) — unsealing, appending to existing row")
                    inst.messages[inst.messages.count - 1].sealed = false
                }
            } else {
                // Last message is a tool row, system row, or messages is empty —
                // this is a genuine new assistant turn. Open a fresh row.
                inst.messages.append(Message(id: UUID().uuidString, role: .assistant, content: text, timestamp: Date().timeIntervalSince1970 * 1000))
            }
        }
        engineTurnHasText.insert(tabId)
        // Set tab running if this is the active instance
        let isActive = activeEngineInstance[tabId] == instanceId || (instanceId == nil)
        if isActive, let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            tabs[idx].status = .running
        }
    }

    @MainActor
    func handleEngineMessageEnd(tabId: String, instanceId: String?, inputTokens: Int?, contextPercent: Double?) {
        // Clear pinned prompt after message completes
        enginePinnedPrompt[tabId] = nil
        // Update context stats only — do NOT set status to .idle here.
        // The agent may continue with tool calls after a message ends.
        // Tab status transitions to idle only via authoritative events:
        // tabStatus, taskComplete, engineDead, or snapshot reconciliation.
        let isActive = activeEngineInstance[tabId] == instanceId || (instanceId == nil)
        if isActive, let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            tabs[idx].contextTokens = inputTokens
            tabs[idx].contextPercent = contextPercent
        }

        // Seal the last assistant message so the next text delta starts fresh.
        mutateEngineInstance(tabId: tabId, instanceId: instanceId) { inst in
            if let lastIdx = inst.messages.indices.last, inst.messages[lastIdx].role == .assistant {
                inst.messages[lastIdx].sealed = true
            }
        }

        engineTurnHasText.remove(tabId)
    }

    @MainActor
    func handleEngineDead(tabId: String, instanceId: String?, exitCode: Int?, signal: String?, stderrTail: [String]) {
        DiagnosticLog.log("ENGINE: dead tabId=\(tabId.prefix(8)) exitCode=\(exitCode ?? -1) signal=\(signal ?? "nil")")
        // exitCode 0/nil = normal exit or idle cleanup, not a real death
        guard let exitCode, exitCode != 0 else { return }
        // Only mark tab dead if no other instances are running
        let instId = instanceId
        let others = conversationInstances[tabId]?.filter { $0.id != instId } ?? []
        if others.isEmpty {
            if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
                tabs[idx].status = .dead
            }
        }
        // Add a system message about the death
        var deathMsg = "Engine process died (exit code \(exitCode))"
        if let signal { deathMsg += ", signal: \(signal)" }
        if !stderrTail.isEmpty { deathMsg += "\n" + stderrTail.suffix(5).joined(separator: "\n") }
        let msg = Message(id: UUID().uuidString, role: .system, content: deathMsg, timestamp: Date().timeIntervalSince1970 * 1000)
        mutateEngineInstance(tabId: tabId, instanceId: instanceId) { $0.messages.append(msg) }
    }

    // handleEngineInstanceRemoved was removed in #256 (single-instance collapse).
    // The engine_instance_added/removed/moved events are still emitted by the
    // desktop but iOS drops them in handleEvent — the snapshot is the
    // authoritative source of instance truth. Per-tab conversation state
    // (messages, liveText, workingMessage, thinkingMessageId) lives on the
    // single ConversationInstanceInfo and is dropped wholesale when the tab
    // closes — no per-map cleanup is needed.

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
            DiagnosticLog.log("ENGINE: agent_conversation_history agent=\(agentName) convId=\(convId) count=\(messages.count) filtered=\(filtered.count) snapshotOp=\(wasAlreadyCached ? "replace" : "first-populate")")
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
            DiagnosticLog.log("ENGINE: agent_conversation_history agent=\(agentName) (legacy) count=\(messages.count) filtered=\(filtered.count)")
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
        DiagnosticLog.log("ENGINE: loading agent conversation agent=\(agent.name) convIds=\(agent.conversationIds)")
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
        DiagnosticLog.log("ENGINE: loading dispatch conversation agent=\(agent.name) convId=\(conversationId)")
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
        DiagnosticLog.log("ENGINE: refresh dispatch conversation agent=\(agent.name) convId=\(conversationId)")
        agentConversationLoading.insert(conversationId)
        send(.loadAgentConversation(conversationIds: [conversationId]), intent: .automaticEssential)
    }

    /// Invalidates and re-fetches all conversation data for an agent.
    @MainActor
    func refreshAgentConversation(agent: AgentStateUpdate) {
        guard !agent.conversationIds.isEmpty else { return }
        guard !agentConversationLoading.contains(agent.name) else { return }
        DiagnosticLog.log("ENGINE: refresh agent conversation agent=\(agent.name) convIds=\(agent.conversationIds)")
        agentConversationMessages.removeValue(forKey: agent.name)
        agentConversationLoading.insert(agent.name)
        send(.loadAgentConversation(conversationIds: agent.conversationIds), intent: .automaticEssential)
    }

    // MARK: - Diagnostic log request

    @MainActor
    func handleRequestDiagnosticLogs() {
        let logs = DiagnosticLog.exportAllSessions()
        let deviceId = activeDeviceId ?? "unknown"
        let deviceName = UIDevice.current.name
        send(.diagnosticLogsResponse(logs: logs, deviceId: deviceId, deviceName: deviceName), intent: .automaticEssential)
    }

    // MARK: - Dispatch terminal cleanup
    // clearTerminalDispatchCaches is in SessionViewModel+DispatchCacheInvalidation.swift,
    // which owns all dispatch cache invalidation logic (Fix A + Fix B).
}

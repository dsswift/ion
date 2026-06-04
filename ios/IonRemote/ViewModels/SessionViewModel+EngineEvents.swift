import Foundation
import UIKit

// MARK: - Engine Event Handlers

extension SessionViewModel {

    @MainActor
    func handleEngineHarnessMessage(tabId: String, instanceId: String?, message: String) {
        let key = instanceId != nil ? "\(tabId):\(instanceId!)" : tabId
        var msgs = engineMessages[key] ?? []
        // Divider messages (session-start, implement, etc.) may be relayed
        // from the desktop as engine_harness_message. Detect the `──` sentinel
        // prefix and create a system-role message so they render with the
        // proper divider visual treatment instead of the harness gear icon.
        let role: MessageRole = message.hasPrefix("──") ? .system : .harness
        msgs.append(Message(id: UUID().uuidString, role: role, content: message, timestamp: Date().timeIntervalSince1970 * 1000))
        engineMessages[key] = msgs
    }

    @MainActor
    func handleEnginePlanModeChanged(tabId: String, instanceId: String?, planModeEnabled: Bool, planSlug: String?) {
        // Insert a "Plan created" lifecycle divider each time the engine
        // enters plan mode. Mirrors the desktop's engine-event-slice.ts
        // handler. planModeEnabled=false is a proposal (ExitPlanMode) and
        // is intentionally ignored — the desktop handles the approval flow.
        guard planModeEnabled else { return }
        let key = instanceId != nil ? "\(tabId):\(instanceId!)" : tabId
        var msgs = engineMessages[key] ?? []
        let slug = planSlug ?? ""
        let time = Date()
        let formatter = DateFormatter()
        formatter.dateFormat = "h:mm a"
        let timeStr = formatter.string(from: time)
        let content = slug.isEmpty
            ? "── Plan created at \(timeStr) ──"
            : "── Plan created at \(timeStr) · \(slug) ──"
        msgs.append(Message(id: UUID().uuidString, role: .system, content: content, timestamp: time.timeIntervalSince1970 * 1000))
        engineMessages[key] = msgs
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
        let key = instanceId != nil ? "\(tabId):\(instanceId!)" : tabId
        var msgs = engineMessages[key] ?? []
        let time = Date()
        let formatter = DateFormatter()
        formatter.dateFormat = "h:mm a"
        let timeStr = formatter.string(from: time)
        let content = "── Steer applied at \(timeStr) · \(messageLength) chars ──"
        msgs.append(Message(id: UUID().uuidString, role: .system, content: content, timestamp: time.timeIntervalSince1970 * 1000))
        engineMessages[key] = msgs
    }

    @MainActor
    func handleEngineToolStart(tabId: String, instanceId: String?, toolName: String, toolId: String) {
        DiagnosticLog.log("ENGINE: tool-start tabId=\(tabId.prefix(8)) tool=\(toolName) toolId=\(toolId.prefix(8))")
        let key = instanceId != nil ? "\(tabId):\(instanceId!)" : tabId
        let info = ActiveToolInfo(id: toolId, toolName: toolName, startTime: Date())
        activeTools[key, default: [:]][toolId] = info
        // Add tool message to conversation
        var msgs = engineMessages[key] ?? []
        msgs.append(Message(id: toolId, role: .tool, content: "", toolName: toolName, toolId: toolId, toolStatus: .running, timestamp: Date().timeIntervalSince1970 * 1000))
        engineMessages[key] = msgs
    }

    @MainActor
    func handleEngineToolEnd(tabId: String, instanceId: String?, toolId: String, result: String?, isError: Bool) {
        DiagnosticLog.log("ENGINE: tool-end tabId=\(tabId.prefix(8)) toolId=\(toolId.prefix(8)) isError=\(isError)")
        let key = instanceId != nil ? "\(tabId):\(instanceId!)" : tabId
        activeTools[key]?[toolId] = nil
        if activeTools[key]?.isEmpty == true {
            activeTools.removeValue(forKey: key)
        }
        // Update tool message status in conversation
        if var msgs = engineMessages[key],
           let idx = msgs.lastIndex(where: { $0.toolId == toolId }) {
            msgs[idx].toolStatus = isError ? .error : .completed
            if let result = result {
                msgs[idx].content = result
            }
            engineMessages[key] = msgs
        }
    }

    @MainActor
    func handleEngineError(tabId: String, instanceId: String?, message: String) {
        DiagnosticLog.log("ENGINE: error tabId=\(tabId.prefix(8)) msg=\(message.prefix(80))")
        let key = instanceId != nil ? "\(tabId):\(instanceId!)" : tabId
        // Add error as system message in conversation
        var msgs = engineMessages[key] ?? []
        msgs.append(Message(id: UUID().uuidString, role: .system, content: "Error: \(message)", timestamp: Date().timeIntervalSince1970 * 1000))
        engineMessages[key] = msgs
        // Reset tab to idle so user can retry
        let isActive = activeEngineInstance[tabId] == instanceId || (instanceId == nil)
        if isActive, let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            tabs[idx].status = .idle
        }
    }

    @MainActor
    func handleEngineNotify(tabId: String, instanceId: String?, message: String, level: String?) {
        DiagnosticLog.log("ENGINE: notify tabId=\(tabId.prefix(8)) level=\(level ?? "info") msg=\(message.prefix(60))")
        let key = instanceId != nil ? "\(tabId):\(instanceId!)" : tabId
        // Surface notifications as system messages in the conversation
        var msgs = engineMessages[key] ?? []
        let prefix = level == "warning" ? "⚠️ " : level == "error" ? "❌ " : ""
        msgs.append(Message(id: UUID().uuidString, role: .system, content: "\(prefix)\(message)", timestamp: Date().timeIntervalSince1970 * 1000))
        engineMessages[key] = msgs
    }

    @MainActor
    func handleEngineTextDelta(tabId: String, instanceId: String?, text: String) {
        let key = instanceId != nil ? "\(tabId):\(instanceId!)" : tabId
        var msgs = engineMessages[key] ?? []
        if let last = msgs.last, last.role == .assistant, !last.sealed {
            msgs[msgs.count - 1].content += text
        } else {
            msgs.append(Message(id: UUID().uuidString, role: .assistant, content: text, timestamp: Date().timeIntervalSince1970 * 1000))
        }
        engineMessages[key] = msgs
        engineTurnHasText.insert(key)
        // Set tab running if this is the active instance
        let isActive = activeEngineInstance[tabId] == instanceId || (instanceId == nil)
        if isActive, let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            tabs[idx].status = .running
        }
    }

    @MainActor
    func handleEngineMessageEnd(tabId: String, instanceId: String?, inputTokens: Int?, contextPercent: Double?) {
        let key = instanceId != nil ? "\(tabId):\(instanceId!)" : tabId
        // Clear pinned prompt after message completes
        enginePinnedPrompt[key] = nil
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
        var engineMsgs = engineMessages[key] ?? []
        if let lastIdx = engineMsgs.indices.last, engineMsgs[lastIdx].role == .assistant {
            engineMsgs[lastIdx].sealed = true
            engineMessages[key] = engineMsgs
        }

        engineTurnHasText.remove(key)
    }

    @MainActor
    func handleEngineDead(tabId: String, instanceId: String?, exitCode: Int?, signal: String?, stderrTail: [String]) {
        DiagnosticLog.log("ENGINE: dead tabId=\(tabId.prefix(8)) exitCode=\(exitCode ?? -1) signal=\(signal ?? "nil")")
        // exitCode 0/nil = normal exit or idle cleanup, not a real death
        guard let exitCode, exitCode != 0 else { return }
        // Only mark tab dead if no other instances are running
        let instId = instanceId
        let others = engineInstances[tabId]?.filter { $0.id != instId } ?? []
        if others.isEmpty {
            if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
                tabs[idx].status = .dead
            }
        }
        // Add a system message about the death
        let key = instanceId != nil ? "\(tabId):\(instanceId!)" : tabId
        var msgs = engineMessages[key] ?? []
        var deathMsg = "Engine process died (exit code \(exitCode))"
        if let signal { deathMsg += ", signal: \(signal)" }
        if !stderrTail.isEmpty { deathMsg += "\n" + stderrTail.suffix(5).joined(separator: "\n") }
        msgs.append(Message(id: UUID().uuidString, role: .system, content: deathMsg, timestamp: Date().timeIntervalSince1970 * 1000))
        engineMessages[key] = msgs
    }

    @MainActor
    func handleEngineInstanceRemoved(tabId: String, instanceId: String) {
        engineInstances[tabId]?.removeAll { $0.id == instanceId }
        if activeEngineInstance[tabId] == instanceId {
            activeEngineInstance[tabId] = engineInstances[tabId]?.first?.id
        }
        // Clean up compound-keyed state for removed instance
        let removedKey = "\(tabId):\(instanceId)"
        engineAgentStates.removeValue(forKey: removedKey)
        engineStatusFields.removeValue(forKey: removedKey)
        engineWorkingMessages.removeValue(forKey: removedKey)
        engineDialogs.removeValue(forKey: removedKey)
        enginePinnedPrompt.removeValue(forKey: removedKey)
        activeTools.removeValue(forKey: removedKey)
        engineMessages.removeValue(forKey: removedKey)
        engineConversationLoaded.remove(removedKey)
        engineTurnHasText.remove(removedKey)
    }

    // MARK: - Agent conversation history

    @MainActor
    func handleAgentConversationHistory(agentName: String, conversationId: String?, messages: [Message]) {
        let filtered = messages.filter { $0.isInternal != true }
        // When a conversationId is present (single-dispatch load), cache
        // under that key so each dispatch is cached independently.
        if let convId = conversationId, !convId.isEmpty {
            DiagnosticLog.log("ENGINE: agent_conversation_history agent=\(agentName) convId=\(convId) count=\(messages.count) filtered=\(filtered.count)")
            agentConversationMessages[convId] = filtered
            agentConversationLoading.remove(convId)
        } else {
            // Legacy fallback: store under agent name for multi-convId loads
            DiagnosticLog.log("ENGINE: agent_conversation_history agent=\(agentName) (legacy) count=\(messages.count) filtered=\(filtered.count)")
            agentConversationMessages[agentName] = filtered
            agentConversationLoading.remove(agentName)
        }
    }

    @MainActor
    func loadAgentConversation(agent: AgentStateUpdate) {
        guard !agent.conversationIds.isEmpty else { return }
        guard !agentConversationLoading.contains(agent.name) else { return }
        DiagnosticLog.log("ENGINE: loading agent conversation agent=\(agent.name) convIds=\(agent.conversationIds)")
        agentConversationLoading.insert(agent.name)
        send(.loadAgentConversation(conversationIds: agent.conversationIds))
    }

    /// Load a single dispatch's conversation by conversationId.
    @MainActor
    func loadAgentDispatchConversation(agent: AgentStateUpdate, conversationId: String) {
        guard !conversationId.isEmpty else { return }
        // Already cached or in-flight — skip.
        guard agentConversationMessages[conversationId] == nil else { return }
        guard !agentConversationLoading.contains(conversationId) else { return }
        DiagnosticLog.log("ENGINE: loading dispatch conversation agent=\(agent.name) convId=\(conversationId)")
        agentConversationLoading.insert(conversationId)
        send(.loadAgentConversation(conversationIds: [conversationId]))
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

    /// Invalidates the cached conversation for a dispatch and re-fetches.
    /// Used by the full-screen agent popup to get fresh data when the
    /// agent's state changes while the popup is open.
    @MainActor
    func refreshAgentDispatchConversation(agent: AgentStateUpdate, conversationId: String) {
        guard !conversationId.isEmpty else { return }
        guard !agentConversationLoading.contains(conversationId) else { return }
        DiagnosticLog.log("ENGINE: refresh dispatch conversation agent=\(agent.name) convId=\(conversationId)")
        // Invalidate cache so the response handler replaces it
        agentConversationMessages.removeValue(forKey: conversationId)
        agentConversationLoading.insert(conversationId)
        send(.loadAgentConversation(conversationIds: [conversationId]))
    }

    /// Invalidates and re-fetches all conversation data for an agent.
    @MainActor
    func refreshAgentConversation(agent: AgentStateUpdate) {
        guard !agent.conversationIds.isEmpty else { return }
        guard !agentConversationLoading.contains(agent.name) else { return }
        DiagnosticLog.log("ENGINE: refresh agent conversation agent=\(agent.name) convIds=\(agent.conversationIds)")
        agentConversationMessages.removeValue(forKey: agent.name)
        agentConversationLoading.insert(agent.name)
        send(.loadAgentConversation(conversationIds: agent.conversationIds))
    }

    // MARK: - Diagnostic log request

    @MainActor
    func handleRequestDiagnosticLogs() {
        let logs = DiagnosticLog.exportAllSessions()
        let deviceId = activeDeviceId ?? "unknown"
        let deviceName = UIDevice.current.name
        send(.diagnosticLogsResponse(logs: logs, deviceId: deviceId, deviceName: deviceName))
    }
}

import Foundation

// MARK: - Engine Event Handlers

extension SessionViewModel {

    @MainActor
    func handleEngineToolStart(tabId: String, instanceId: String?, toolName: String, toolId: String) {
        let key = instanceId != nil ? "\(tabId):\(instanceId!)" : tabId
        let info = ActiveToolInfo(id: toolId, toolName: toolName, startTime: Date())
        activeTools[key, default: [:]][toolId] = info
        // Add tool message to conversation
        var msgs = engineMessages[key] ?? []
        msgs.append(EngineMessage(id: toolId, role: "tool", content: "", toolName: toolName, toolId: toolId, toolStatus: "running", timestamp: Date().timeIntervalSince1970 * 1000))
        engineMessages[key] = msgs
    }

    @MainActor
    func handleEngineToolEnd(tabId: String, instanceId: String?, toolId: String, result: String?, isError: Bool) {
        let key = instanceId != nil ? "\(tabId):\(instanceId!)" : tabId
        activeTools[key]?[toolId] = nil
        if activeTools[key]?.isEmpty == true {
            activeTools.removeValue(forKey: key)
        }
        // Update tool message status in conversation
        if var msgs = engineMessages[key],
           let idx = msgs.lastIndex(where: { $0.toolId == toolId }) {
            msgs[idx].toolStatus = isError ? "error" : "completed"
            if let result = result {
                msgs[idx].content = result
            }
            engineMessages[key] = msgs
        }
    }

    @MainActor
    func handleEngineError(tabId: String, instanceId: String?, message: String) {
        let key = instanceId != nil ? "\(tabId):\(instanceId!)" : tabId
        // Add error as system message in conversation
        var msgs = engineMessages[key] ?? []
        msgs.append(EngineMessage(id: UUID().uuidString, role: "system", content: "Error: \(message)", timestamp: Date().timeIntervalSince1970 * 1000))
        engineMessages[key] = msgs
        // Reset tab to idle so user can retry
        let isActive = activeEngineInstance[tabId] == instanceId || (instanceId == nil)
        if isActive, let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            tabs[idx].status = .idle
        }
    }

    @MainActor
    func handleEngineNotify(tabId: String, instanceId: String?, message: String, level: String?) {
        let key = instanceId != nil ? "\(tabId):\(instanceId!)" : tabId
        // Surface notifications as system messages in the conversation
        var msgs = engineMessages[key] ?? []
        let prefix = level == "warning" ? "⚠️ " : level == "error" ? "❌ " : ""
        msgs.append(EngineMessage(id: UUID().uuidString, role: "system", content: "\(prefix)\(message)", timestamp: Date().timeIntervalSince1970 * 1000))
        engineMessages[key] = msgs
    }

    @MainActor
    func handleEngineTextDelta(tabId: String, instanceId: String?, text: String) {
        let key = instanceId != nil ? "\(tabId):\(instanceId!)" : tabId
        var msgs = engineMessages[key] ?? []
        if let last = msgs.last, last.role == "assistant" {
            msgs[msgs.count - 1].content += text
        } else {
            msgs.append(EngineMessage(id: UUID().uuidString, role: "assistant", content: text, timestamp: Date().timeIntervalSince1970 * 1000))
        }
        engineMessages[key] = msgs
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
        // Set tab idle and update context stats if this is the active instance
        let isActive = activeEngineInstance[tabId] == instanceId || (instanceId == nil)
        if isActive, let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            tabs[idx].status = .idle
            tabs[idx].contextTokens = inputTokens
            tabs[idx].contextPercent = contextPercent
        }
    }

    @MainActor
    func handleEngineDead(tabId: String, instanceId: String?, exitCode: Int?, signal: String?, stderrTail: [String]) {
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
        msgs.append(EngineMessage(id: UUID().uuidString, role: "system", content: deathMsg, timestamp: Date().timeIntervalSince1970 * 1000))
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
    }
}

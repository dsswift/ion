import Foundation

extension SessionViewModel {
    /// The engine is retrying after abandoning a partial provider attempt.
    /// Remove every uncommitted row because a tool row starts before its JSON
    /// arguments complete or its executor runs.
    @MainActor
    func handleEngineStreamReset(tabId: String, instanceId: String?) {
        var discardedRows = 0
        var discardedToolIds: [String] = []

        if let msgId = thinkingMessageId(tabId) {
            setThinkingMessageId(tabId: tabId, nil)
            mutateEngineInstance(tabId: tabId, instanceId: instanceId) { inst in
                if let idx = inst.messages.lastIndex(where: { $0.id == msgId }) {
                    inst.messages.remove(at: idx)
                    discardedRows += 1
                }
            }
        }

        mutateEngineInstance(tabId: tabId, instanceId: instanceId) { inst in
            let beforeCount = inst.messages.count
            inst.messages.removeAll { message in
                let partialAssistant = message.role == .assistant && message.toolName == nil && !message.sealed
                let partialTool = message.role == .tool && message.toolStatus == .running
                if partialTool, let toolId = message.toolId {
                    discardedToolIds.append(toolId)
                }
                return partialAssistant || partialTool
            }
            discardedRows += beforeCount - inst.messages.count
        }

        if var tools = activeTools[tabId] {
            for toolId in discardedToolIds {
                tools.removeValue(forKey: toolId)
            }
            if tools.isEmpty {
                activeTools.removeValue(forKey: tabId)
            } else {
                activeTools[tabId] = tools
            }
        }
        engineTurnHasText.remove(tabId)
        DiagnosticLog.log("stream reset discarded partial attempt", tag: "session.engine", level: .info, fields: [
            "tab_id": String(tabId.prefix(8)),
            "discarded_rows": String(discardedRows)
        ])
    }
}

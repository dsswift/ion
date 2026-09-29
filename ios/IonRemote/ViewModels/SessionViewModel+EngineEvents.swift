import Foundation

// MARK: - Engine Event Handlers
//
// Only what an engine event changes besides the transcript: tab status,
// context usage, the pinned prompt. Every row comes from the server's
// transcript (SessionViewModel+Transcript.swift).

extension SessionViewModel {

    @MainActor
    func handleEngineError(tabId: String, instanceId: String?, message: String) {
        DiagnosticLog.log("engine error", tag: "session.engine", level: .error, fields: [
            "tab_id": String(tabId.prefix(8)),
            "error": String(message.prefix(80))
        ])
        // The error's row is in the server's transcript. Here the tab goes
        // idle at once so the user can retry.
        let isActive = activeEngineInstance[tabId] == instanceId || (instanceId == nil)
        if isActive, let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            tabs[idx].status = .idle
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
    }

    @MainActor
    func handleEngineDead(tabId: String, instanceId: String?, exitCode: Int?, signal: String?, stderrTail: [String]) {
        DiagnosticLog.log("engine dead", tag: "session.engine", level: .warn, fields: [
            "tab_id": String(tabId.prefix(8)),
            "status": String(exitCode ?? -1),
            "reason": signal ?? "nil"
        ])
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
    }

    /// Per-category context breakdown from the engine (forwarded by the desktop).
    /// Stored on the active instance so StatusDrawerView can read it without a
    /// separate fetch. Mirrors the desktop's engine-event-slice handler that
    /// writes contextBreakdown onto the ConversationInstance. Extracted from
    /// SessionViewModel+EventHandlers.swift to keep that file under the
    /// 600-line cap.
    @MainActor
    func handleContextBreakdown(tabId: String, instanceId: String?, payload: ContextBreakdownPayload) {
        DiagnosticLog.log("context breakdown", tag: "session.events", level: .debug, fields: [
            "tab_id": String(tabId.prefix(8)),
            "count": String(payload.categories.count),
            "max": String(payload.totalTokens)
        ])
        mutateEngineInstance(tabId: tabId, instanceId: instanceId) {
            $0.contextBreakdown = payload
        }
    }
}

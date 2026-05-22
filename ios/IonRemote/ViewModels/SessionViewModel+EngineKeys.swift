import Foundation

// MARK: - Engine compound-key helpers
//
// Engine events are keyed by `tabId:instanceId` (the "compound key"). This
// file holds the two helpers SessionViewModel+EventHandlers uses to keep
// that keying consistent with how the view layer looks state up:
//
//   - resolveEngineKey: builds the compound key for an incoming event,
//     falling back to the active instance when the engine omits instanceId.
//
//   - rekeyEngineMaps: when an engine instance moves between tabs, walks
//     every compound-keyed dictionary and rewrites entries so the agent
//     panel / status bar / working banner / tool state follow the instance
//     to its new tab.
//
// Both helpers live on SessionViewModel via extension. They are intentionally
// in a separate file because EventHandlers.swift is near the 600-line cap;
// see .file-size-allowlist.yml and docs/architecture/file-organization.md.

extension SessionViewModel {

    /// Build the compound key used to store engine state for an event.
    ///
    /// When the engine omits `instanceId` we resolve to the active engine
    /// instance for this tab (falling back to the first registered
    /// instance). This matches how `engineCompoundKey(tabId:)` constructs
    /// keys for view lookup, so an event with a nil instanceId still
    /// lands under the same key the EngineView reads.
    ///
    /// Desktop today always sends an instanceId so this fallback is
    /// defensive — it guards against a future emitter (test harness or
    /// new event source) that sends nil and prevents the "agent state
    /// stored under bare tabId, view reads tabId:instanceId" mismatch.
    @MainActor
    func resolveEngineKey(tabId: String, instanceId: String?) -> String {
        if let id = instanceId {
            return "\(tabId):\(id)"
        }
        let resolved = activeEngineInstance[tabId] ?? engineInstances[tabId]?.first?.id
        if let id = resolved {
            DiagnosticLog.log("ENGINE: agent_state: nil instanceId tabId=\(tabId.prefix(8)) resolved=\(id.prefix(8))")
            return "\(tabId):\(id)"
        }
        DiagnosticLog.log("ENGINE: agent_state: nil instanceId tabId=\(tabId.prefix(8)) no_instance_known (falling back to bare tabId)")
        return tabId
    }

    /// Rekey every compound-keyed dictionary from `oldKey` to `newKey`.
    /// Called when an engine instance moves between tabs so the agent
    /// panel, status bar, working banner, dialogs, and active tools
    /// follow the instance rather than orphaning under the old key.
    ///
    /// The canonical set of maps is the one already cleaned up in
    /// `handleTabClosed` (SessionViewModel+TabEventHandlers.swift). Any
    /// new compound-keyed map added to SessionViewModel must be added
    /// to BOTH that cleanup and this helper, or instance moves and tab
    /// closes will silently leak state.
    ///
    /// Mirrors desktop's `engine-slice.ts:200-230` rekey<V> helper.
    @MainActor
    func rekeyEngineMaps(oldKey: String, newKey: String) {
        var moved: [String] = []
        func move<V>(_ name: String, _ dict: inout [String: V]) {
            if let value = dict.removeValue(forKey: oldKey) {
                dict[newKey] = value
                moved.append(name)
            }
        }
        move("engineAgentStates", &engineAgentStates)
        move("engineStatusFields", &engineStatusFields)
        move("engineWorkingMessages", &engineWorkingMessages)
        move("engineDialogs", &engineDialogs)
        move("enginePinnedPrompt", &enginePinnedPrompt)
        move("engineModelOverrides", &engineModelOverrides)
        move("engineMessages", &engineMessages)
        move("activeTools", &activeTools)
        // Sets need bespoke handling.
        if engineConversationLoaded.contains(oldKey) {
            engineConversationLoaded.remove(oldKey)
            engineConversationLoaded.insert(newKey)
            moved.append("engineConversationLoaded")
        }
        if engineTurnHasText.contains(oldKey) {
            engineTurnHasText.remove(oldKey)
            engineTurnHasText.insert(newKey)
            moved.append("engineTurnHasText")
        }
        DiagnosticLog.log("ENGINE: rekey \(oldKey) -> \(newKey) moved=[\(moved.joined(separator: ","))]")
    }
}

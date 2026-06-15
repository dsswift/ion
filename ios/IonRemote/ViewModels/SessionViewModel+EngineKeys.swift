import Foundation

// MARK: - Engine compound-key helpers
//
// Engine events are keyed by `tabId:instanceId` (the "compound key"). This
// file holds the helpers SessionViewModel+EventHandlers uses to keep that
// keying consistent with how the view layer looks state up:
//
//   - resolveEngineKey: builds the compound key for an incoming event,
//     falling back to the active instance when the engine omits instanceId.
//
//   - engineInstance(tabId:instanceId:): read-only lookup of an
//     ConversationInstanceInfo by (tabId, instanceId).
//
//   - mutateEngineInstance(tabId:instanceId:_:): write path — finds the
//     instance by index and applies a mutating closure in place. The 4
//     conversation fields (messages, agentStates, statusFields,
//     modelOverride) live on the struct so this is the single write site.
//
//   - rekeyEngineMaps: when an engine instance moves between tabs, walks
//     every remaining compound-keyed dictionary (working message, dialogs,
//     pinned prompt, active tools) so they follow the instance to its new
//     tab. The 4 conversation fields are NOT rekeyed here — they travel
//     with the ConversationInstanceInfo struct when conversationInstances is updated.
//
// All helpers live on SessionViewModel via extension. They are intentionally
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
        let resolved = activeEngineInstance[tabId] ?? conversationInstances[tabId]?.first?.id
        if let id = resolved {
            DiagnosticLog.log("ENGINE: agent_state: nil instanceId tabId=\(tabId.prefix(8)) resolved=\(id.prefix(8))")
            return "\(tabId):\(id)"
        }
        DiagnosticLog.log("ENGINE: agent_state: nil instanceId tabId=\(tabId.prefix(8)) no_instance_known (falling back to bare tabId)")
        return tabId
    }

    /// Resolve `instanceId` the same way `resolveEngineKey` does, then
    /// return the matching `ConversationInstanceInfo` (if any). Used by write
    /// sites that need the actual instanceId string after nil-resolution
    /// before calling `mutateEngineInstance`.
    @MainActor
    func resolveInstanceId(tabId: String, instanceId: String?) -> String? {
        if let id = instanceId { return id }
        return activeEngineInstance[tabId] ?? conversationInstances[tabId]?.first?.id
    }

    /// Return the `ConversationInstanceInfo` for a given (tabId, instanceId) pair,
    /// or nil when no matching instance is registered. Pass nil for
    /// `instanceId` to look up the active instance.
    @MainActor
    func engineInstance(tabId: String, instanceId: String?) -> ConversationInstanceInfo? {
        let id = instanceId ?? activeEngineInstance[tabId] ?? conversationInstances[tabId]?.first?.id
        guard let id else { return nil }
        return conversationInstances[tabId]?.first(where: { $0.id == id })
    }

    /// Mutate the `ConversationInstanceInfo` identified by (tabId, instanceId)
    /// in place. Pass nil for `instanceId` to target the active instance.
    /// No-ops silently when the instance is not found (defensive — mirrors
    /// the dict-write pattern that simply overwrites an absent key).
    @MainActor
    func mutateEngineInstance(tabId: String, instanceId: String?, _ body: (inout ConversationInstanceInfo) -> Void) {
        let id = instanceId ?? activeEngineInstance[tabId] ?? conversationInstances[tabId]?.first?.id
        guard let id,
              let idx = conversationInstances[tabId]?.firstIndex(where: { $0.id == id })
        else { return }
        body(&conversationInstances[tabId]![idx])
    }

    /// Rekey every remaining compound-keyed dictionary from `oldKey` to
    /// `newKey`. Called when an engine instance moves between tabs.
    ///
    /// Note: the 4 conversation fields (messages, agentStates, statusFields,
    /// modelOverride) are NOT in this list — they live on ConversationInstanceInfo
    /// and travel with the struct when conversationInstances is updated in the
    /// `.engineInstanceMoved` handler. Only the maps that still live as
    /// standalone dictionaries on SessionViewModel are rekeyed here.
    ///
    /// The canonical set of maps is the one cleaned up in `handleTabClosed`
    /// (SessionViewModel+TabEventHandlers.swift). Any new compound-keyed map
    /// added to SessionViewModel must be added to BOTH that cleanup and this
    /// helper, or instance moves and tab closes will silently leak state.
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
        move("engineWorkingMessages", &engineWorkingMessages)
        move("engineDialogs", &engineDialogs)
        move("enginePinnedPrompt", &enginePinnedPrompt)
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

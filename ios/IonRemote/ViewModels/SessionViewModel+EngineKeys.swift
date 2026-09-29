import Foundation

// MARK: - Engine instance helpers
//
// Post-#256: every tab has exactly ONE conversation instance (the `main`
// instance — see SessionViewModel+Conversation.swift / ensureMainInstance).
// The pre-#256 compound "tabId:instanceId" key form is fully retired; engine
// session state is keyed by bare tabId everywhere.
//
// This file holds the read/write helpers for that single instance:
//
//   - engineInstance(tabId:instanceId:): read-only lookup of the tab's single
//     ConversationInstanceInfo. The `instanceId` parameter is vestigial
//     (always the single instance) and ignored; it is retained only so the
//     existing call sites that thread `activeInstanceId` compile unchanged.
//
//   - mutateEngineInstance(tabId:instanceId:_:): write path — ensures the
//     single instance exists, then applies a mutating closure in place.
//
//   - parseEngineSessionKey: static helper that tolerates a legacy compound
//     key — strips a ":instanceId" suffix if present, returns bare tabId. Used
//     by the draft legacy-migration and AgentDetailFullScreenView's cached-key
//     read path, which can still encounter a pre-#256 compound key.
//
// All helpers live on SessionViewModel via extension. They are intentionally
// in a separate file because EventHandlers.swift is near the 600-line cap.

extension SessionViewModel {

    /// Return the tab's single `ConversationInstanceInfo`, or nil when the tab
    /// has no instance yet. The `instanceId` parameter is vestigial post-#256
    /// (a tab has exactly one instance) and is ignored — kept only for call-site
    /// compatibility with sites that thread `activeInstanceId`.
    @MainActor
    func engineInstance(tabId: String, instanceId: String?) -> ConversationInstanceInfo? {
        conversationInstances[tabId]?.first
    }

    /// The model a conversation falls back to when it has no pick of its own,
    /// as its SERVER resolved it (owner's defaults, harness default folded in).
    /// Empty when the server resolved nothing. Never the phone's own idea of a
    /// default: that says nothing about a conversation on another server.
    @MainActor
    func resolvedModel(tabId: String, instanceId: String?) -> String {
        engineInstance(tabId: tabId, instanceId: instanceId)?.resolvedModel
            ?? tab(for: tabId)?.resolvedModel
            ?? ""
    }

    /// Mutate the tab's single `ConversationInstanceInfo` in place. Ensures the
    /// `main` instance exists first (creating it for a plain tab or a
    /// not-yet-snapshotted engine tab) rather than silently no-opping, then
    /// applies the caller's mutation. The `instanceId` parameter is vestigial
    /// post-#256 and ignored (a tab has exactly one instance).
    @MainActor
    func mutateEngineInstance(tabId: String, instanceId: String?, _ body: (inout ConversationInstanceInfo) -> Void) {
        ensureMainInstance(tabId: tabId)
        guard !(conversationInstances[tabId]?.isEmpty ?? true) else { return }
        body(&conversationInstances[tabId]![0])
    }

    /// Parse a possibly-compound engine session key into its bare tabId.
    ///
    /// Pre-#256 keys had the form "tabId:instanceId". Post-#256 the key is
    /// just bare tabId. This helper tolerates both forms so that any
    /// cached compound key (e.g. from a UserDefaults-persisted engine draft
    /// written before the upgrade) resolves correctly to the bare tabId.
    ///
    /// Terminal keys are NOT parsed here — this helper is for engine/
    /// conversation session keys only.
    ///
    /// Examples:
    ///   "tab-abc"         -> "tab-abc"
    ///   "tab-abc:main"    -> "tab-abc"
    ///   "tab-abc:inst-xy" -> "tab-abc"
    static func parseEngineSessionKey(_ key: String) -> String {
        guard let colonIdx = key.firstIndex(of: ":") else { return key }
        return String(key[..<colonIdx])
    }
}

import Foundation

// MARK: - Unified conversation accessors (#256 iOS unification)
//
// Post-#256 every non-terminal tab — plain or extension — owns exactly one
// `ConversationInstanceInfo` (the `main` instance) that carries all of its
// conversation state: messages, agent states, status, and model override.
// This mirrors the desktop's single `ConversationInstance` per pane.
//
// These accessors read the one instance every tab owns. Its `messages` are
// written only by SessionViewModel+Transcript.swift, from the server's
// transcript.
//
// `ensureMainInstance` guarantees the single instance exists before any write,
// so plain tabs get a `main` instance the same way engine tabs do.

extension SessionViewModel {

    // MARK: - Instance lifecycle

    /// Ensure the tab has its single `main` conversation instance. Creates one
    /// if absent (plain tabs, or an engine tab seen before its first snapshot).
    /// Idempotent: when an instance already exists for the tab this is a no-op,
    /// preserving the existing runtime state (messages, status).
    ///
    /// The created instance uses `ConversationInstanceInfo.mainInstanceId` so
    /// the resolver and any wire surface that still carries an instance id
    /// agree on the key.
    @MainActor
    @discardableResult
    func ensureMainInstance(tabId: String) -> String {
        if let existing = conversationInstances[tabId]?.first {
            // Make sure the active pointer is set so the accessors below find
            // the instance without a snapshot tick.
            if activeEngineInstance[tabId] == nil {
                activeEngineInstance[tabId] = existing.id
            }
            return existing.id
        }
        let id = ConversationInstanceInfo.mainInstanceId
        conversationInstances[tabId] = [ConversationInstanceInfo(id: id, label: "")]
        activeEngineInstance[tabId] = id
        return id
    }

    // MARK: - Messages

    /// The tab's conversation messages, from its single instance. Empty when
    /// the tab has no instance yet (no history loaded, no live events).
    @MainActor
    func conversationMessages(_ tabId: String) -> [Message] {
        conversationInstances[tabId]?.first?.messages ?? []
    }

    // MARK: - Working status line

    /// The tab's transient "working" status line (engine activity indicator).
    @MainActor
    func workingMessage(_ tabId: String) -> String {
        conversationInstances[tabId]?.first?.workingMessage ?? ""
    }

    /// Set (or clear, with "") the tab's working status line.
    @MainActor
    func setWorkingMessage(tabId: String, _ text: String) {
        ensureMainInstance(tabId: tabId)
        guard let idx = conversationInstances[tabId]?.firstIndex(where: { _ in true }) else { return }
        conversationInstances[tabId]![idx].workingMessage = text
    }
}

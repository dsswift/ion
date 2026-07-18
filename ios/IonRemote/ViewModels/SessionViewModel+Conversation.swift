import Foundation

// MARK: - Unified conversation accessors (#256 iOS unification)
//
// Post-#256 every non-terminal tab — plain or extension — owns exactly one
// `ConversationInstanceInfo` (the `main` instance) that carries all of its
// conversation state: messages, live streaming text, agent states, status,
// and model override. This mirrors the desktop's single `ConversationInstance`
// per pane.
//
// These accessors are the single read/write seam for conversation messages
// and live text across BOTH tab types. They replace the old split between the
// engine path (`conversationInstances[tabId][].messages` via
// `mutateEngineInstance`) and the plain path (the loose top-level
// `messages[tabId]` / `liveText[tabId]` dictionaries). Every writer — plain
// `message_added`, engine `text_delta`, tool start/end, thinking, history
// load — funnels through here so there is one store of record.
//
// `ensureMainInstance` guarantees the single instance exists before any write,
// so plain tabs get a `main` instance the same way engine tabs do.

extension SessionViewModel {

    // MARK: - Instance lifecycle

    /// Ensure the tab has its single `main` conversation instance. Creates one
    /// if absent (plain tabs, or an engine tab seen before its first snapshot).
    /// Idempotent: when an instance already exists for the tab this is a no-op,
    /// preserving the existing runtime state (messages, liveText, status).
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

    /// Mutate the tab's conversation messages in place. Ensures the `main`
    /// instance exists first so a write never silently no-ops on a plain tab
    /// that hasn't been touched yet. This is the unified replacement for both
    /// the engine `mutateEngineInstance { $0.messages … }` sites and the plain
    /// `messages[tabId] = …` sites.
    @MainActor
    func mutateConversationMessages(tabId: String, _ body: (inout [Message]) -> Void) {
        ensureMainInstance(tabId: tabId)
        guard let idx = conversationInstances[tabId]?.firstIndex(where: { _ in true }) else { return }
        body(&conversationInstances[tabId]![idx].messages)
    }

    /// Replace the tab's conversation messages wholesale (history load).
    @MainActor
    func setConversationMessages(tabId: String, _ messages: [Message]) {
        mutateConversationMessages(tabId: tabId) { $0 = messages }
    }

    /// Append a row produced by a LIVE event (RC-11), stamping `isLive = true` so
    /// the next first-page history replace can preserve exactly the live tail
    /// instead of estimating it from timestamps. Every live-append site (engine
    /// text/tool/image/harness/notify/error/thinking handlers and the optimistic
    /// submit) funnels through here so the boundary is a stored fact, not a guess.
    /// History rows are set via setConversationMessages and are never live.
    @MainActor
    func appendLiveMessage(tabId: String, instanceId: String? = nil, _ message: Message) {
        var m = message
        m.isLive = true
        if instanceId != nil {
            mutateEngineInstance(tabId: tabId, instanceId: instanceId) { $0.messages.append(m) }
        } else {
            mutateConversationMessages(tabId: tabId) { $0.append(m) }
        }
    }

    // MARK: - Live streaming text

    /// The tab's live streaming-text accumulator (relay text-chunk path).
    @MainActor
    func liveText(_ tabId: String) -> String {
        conversationInstances[tabId]?.first?.liveText ?? ""
    }

    /// Set (or clear, with "") the tab's live streaming text.
    @MainActor
    func setLiveText(tabId: String, _ text: String) {
        ensureMainInstance(tabId: tabId)
        guard let idx = conversationInstances[tabId]?.firstIndex(where: { _ in true }) else { return }
        conversationInstances[tabId]![idx].liveText = text
    }

    /// Append to the tab's live streaming text.
    @MainActor
    func appendLiveText(tabId: String, _ text: String) {
        setLiveText(tabId: tabId, liveText(tabId) + text)
    }

    /// Clear the tab's live streaming text.
    @MainActor
    func clearLiveText(tabId: String) {
        guard let idx = conversationInstances[tabId]?.firstIndex(where: { _ in true }) else { return }
        conversationInstances[tabId]![idx].liveText = ""
    }

    // MARK: - In-progress thinking block

    /// The id of the tab's live `.thinking` message, if a reasoning block is in
    /// progress. Nil otherwise. Backed by the single instance (post-#256).
    @MainActor
    func thinkingMessageId(_ tabId: String) -> String? {
        conversationInstances[tabId]?.first?.thinkingMessageId
    }

    /// Set (or clear, with nil) the tab's in-progress thinking message id.
    @MainActor
    func setThinkingMessageId(tabId: String, _ id: String?) {
        ensureMainInstance(tabId: tabId)
        guard let idx = conversationInstances[tabId]?.firstIndex(where: { _ in true }) else { return }
        conversationInstances[tabId]![idx].thinkingMessageId = id
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

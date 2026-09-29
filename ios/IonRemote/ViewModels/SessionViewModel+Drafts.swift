import Foundation

// MARK: - Input Draft Persistence
//
// Per-tab unsent input text is stored in UserDefaults so the user's in-progress
// input survives app restarts. Post-#256 there is ONE draft store keyed by bare
// tabId for both plain and engine tabs — the desktop has one draft per
// conversation pane, and iOS now matches.
//
// The engine accessors (`engineDraft` / `setEngineDraft` / `clearEngineDrafts`)
// are kept as thin shims over the unified tab-draft store so existing engine
// call sites compile unchanged; they ignore `instanceId` (vestigial post-#256)
// and key on bare tabId. The merged view (Phase 6) will call the tab-draft
// functions directly.
//
// Legacy migration: a prior build persisted engine drafts under a separate
// `engineDraftInputByKey` UserDefaults key, sometimes with compound
// "tabId:instanceId" keys. `hydrateDrafts` folds that payload into the unified
// store once, on first launch after upgrade, then the legacy key is unused.
//
// All writes go through `persistDrafts()`. Reads prefer the in-memory
// dictionary; UserDefaults is only the backing store, hydrated once at init.

extension SessionViewModel {

    // MARK: - UserDefaults keys

    static let draftInputByTabKey = "draftInputByTab"
    /// Legacy key — read once during hydrate to migrate old engine drafts, then
    /// abandoned. Not written anymore.
    static let legacyEngineDraftInputByKeyKey = "engineDraftInputByKey"

    // MARK: - Tab drafts (the single unified store)

    /// Returns the persisted draft for a tab, or "" if none.
    func tabDraft(_ tabId: String) -> String {
        draftInputByTab[tabId] ?? ""
    }

    /// Writes (or clears) a per-tab draft and persists to UserDefaults.
    /// Empty strings remove the key to avoid bloating storage.
    ///
    /// `broadcast` is true for every edit this device made, which forwards the
    /// text to the host on a debounce: the draft belongs to the conversation,
    /// not to the phone, so Ion Studio shows the same half-written prompt and
    /// the host's tabs file carries it across a restart. It is false only when
    /// the value CAME from the host (`adoptRemoteDraft`), where echoing it back
    /// would be a pointless round trip.
    func setTabDraft(_ tabId: String, _ text: String, broadcast: Bool = true) {
        if text.isEmpty {
            if draftInputByTab.removeValue(forKey: tabId) != nil {
                DiagnosticLog.log("draft cleared", tag: "session.drafts", fields: [
                    "tab_id": String(tabId.prefix(8))
                ])
                persistDrafts()
                if broadcast { scheduleDraftSend(tabId, "") }
            }
        } else {
            let prev = draftInputByTab[tabId]
            draftInputByTab[tabId] = text
            if prev != text {
                DiagnosticLog.log("draft updated", tag: "session.drafts", fields: [
                    "tab_id": String(tabId.prefix(8)),
                    "count": String(text.count)
                ])
                persistDrafts()
                if broadcast { scheduleDraftSend(tabId, text) }
            }
        }
    }

    // MARK: - Host synchronisation

    /// How long a keystroke may sit here before the host hears about it.
    ///
    /// A rate limit rather than a cosmetic delay: every send is a frame on the
    /// wire, and per-character forwarding over a relay is wasteful for text the
    /// user has not sent yet. Longer than the desktop's own debounce because a
    /// phone's link is the slower one; short enough that leaving the
    /// conversation almost always finds the write already gone.
    static let draftSendDebounce: TimeInterval = 0.6

    /// Queue the host write for `tabId`, replacing any pending one.
    ///
    /// The work item captures the text so a late fire still sends the value it
    /// was scheduled with, and the entry is dropped from `draftSendWork` as it
    /// runs so the map tracks only genuinely pending sends.
    func scheduleDraftSend(_ tabId: String, _ text: String) {
        draftSendWork[tabId]?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.draftSendWork.removeValue(forKey: tabId)
            self.send(.setDraft(tabId: tabId, text: text), intent: .automaticEssential)
        }
        draftSendWork[tabId] = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.draftSendDebounce, execute: work)
    }

    /// Send any queued draft for `tabId` immediately.
    ///
    /// Called when this device stops owning the composer — leaving the
    /// conversation, or backgrounding — so the unsent tail is not left sitting
    /// in a timer that a suspended app may never run.
    func flushDraftSend(_ tabId: String) {
        guard let work = draftSendWork.removeValue(forKey: tabId) else { return }
        work.cancel()
        work.perform()
    }

    /// Send every queued draft immediately. Used on background/resign.
    func flushAllDraftSends() {
        for tabId in Array(draftSendWork.keys) { flushDraftSend(tabId) }
    }

    /// Take the host's draft for a conversation this device is not editing.
    ///
    /// The rule is ownership, not merging: the composer with the conversation
    /// focused owns its text, and every other device adopts on open. Applying a
    /// push to the focused conversation would move the cursor mid-sentence, so
    /// the caller filters `focusedTabId` out and this only ever writes to a
    /// conversation the user is not looking at. `broadcast: false` — this value
    /// is already the host's.
    func adoptRemoteDraft(tabId: String, text: String) {
        guard draftInputByTab[tabId] ?? "" != text else { return }
        // A queued local send for this conversation is newer than anything the
        // snapshot carries: it was typed here and has not landed yet. Adopting
        // over it would resurrect the text the user just replaced.
        guard draftSendWork[tabId] == nil else {
            DiagnosticLog.log("remote draft ignored; local send pending", tag: "session.drafts", fields: [
                "tab_id": String(tabId.prefix(8))
            ])
            return
        }
        DiagnosticLog.log("remote draft adopted", tag: "session.drafts", fields: [
            "tab_id": String(tabId.prefix(8)),
            "count": String(text.count)
        ])
        setTabDraft(tabId, text, broadcast: false)
    }

    /// Removes a per-tab draft (used when tab is closed).
    func clearTabDraft(_ tabId: String) {
        if draftInputByTab.removeValue(forKey: tabId) != nil {
            DiagnosticLog.log("draft removed", tag: "session.drafts", fields: [
                "tab_id": String(tabId.prefix(8)),
                "reason": "tab closed"
            ])
            persistDrafts()
        }
    }

    // MARK: - Engine drafts (shims over the unified store)

    /// Returns the engine-tab draft. Post-#256 this is the same bare-tabId store
    /// as plain tabs; `instanceId` is ignored.
    func engineDraft(tabId: String, instanceId: String) -> String {
        tabDraft(tabId)
    }

    /// Writes the engine-tab draft to the unified store.
    func setEngineDraft(tabId: String, instanceId: String, _ text: String) {
        setTabDraft(tabId, text)
    }

    /// Removes the engine-tab draft from the unified store.
    func clearEngineDrafts(forTab tabId: String) {
        clearTabDraft(tabId)
    }

    /// Bring the local draft store in line with a tab snapshot.
    ///
    /// Two jobs, both belonging to the draft store rather than to snapshot
    /// merging: forget conversations that no longer exist, and take the host's
    /// draft for every conversation this device is not currently editing. The
    /// focused conversation is deliberately skipped — its composer owns its own
    /// text, and applying a push there would move the cursor mid-sentence.
    func reconcileDraftsWithSnapshot(_ tabs: [RemoteTabState], liveTabIds: Set<String>) {
        // Drafts are scoped to live conversations; a closed one keeps nothing.
        // Post-#256 there is one bare-tabId-keyed store covering plain and
        // engine tabs alike, so a single sweep is enough.
        for tabId in draftInputByTab.keys where !liveTabIds.contains(tabId) {
            clearTabDraft(tabId)
        }
        for tab in tabs where tab.id != focusedTabId {
            adoptRemoteDraft(tabId: tab.id, text: tab.draftInput ?? "")
        }
    }

    // MARK: - Persistence helpers

    /// Writes the unified draft dictionary to UserDefaults.
    func persistDrafts() {
        UserDefaults.standard.set(draftInputByTab, forKey: Self.draftInputByTabKey)
    }

    /// Hydrates the unified draft dictionary from UserDefaults. Called once in
    /// `init`. Folds any legacy `engineDraftInputByKey` payload (including
    /// compound "tabId:instanceId" keys) into the unified bare-tabId store, then
    /// clears the legacy key so the migration runs only once.
    func hydrateDrafts() {
        if let tabMap = UserDefaults.standard.dictionary(forKey: Self.draftInputByTabKey) as? [String: String] {
            draftInputByTab = tabMap
        }
        // One-time legacy migration.
        if let legacy = UserDefaults.standard.dictionary(forKey: Self.legacyEngineDraftInputByKeyKey) as? [String: String],
           !legacy.isEmpty {
            var migrated = 0
            for (key, text) in legacy where !text.isEmpty {
                let bare = SessionViewModel.parseEngineSessionKey(key)
                // Don't clobber a draft the unified store already has for this tab.
                if draftInputByTab[bare] == nil {
                    draftInputByTab[bare] = text
                    migrated += 1
                }
            }
            UserDefaults.standard.removeObject(forKey: Self.legacyEngineDraftInputByKeyKey)
            if migrated > 0 {
                persistDrafts()
            }
            DiagnosticLog.log("draft legacy migration", tag: "session.drafts", fields: [
                "count": String(migrated)
            ])
        }
        DiagnosticLog.log("draft hydrated", tag: "session.drafts", fields: [
            "count": String(draftInputByTab.count)
        ])
    }
}

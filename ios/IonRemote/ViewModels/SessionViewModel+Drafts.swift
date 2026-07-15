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
    func setTabDraft(_ tabId: String, _ text: String) {
        if text.isEmpty {
            if draftInputByTab.removeValue(forKey: tabId) != nil {
                DiagnosticLog.log("draft cleared", tag: "session.drafts", fields: [
                    "tab_id": String(tabId.prefix(8))
                ])
                persistDrafts()
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
            }
        }
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

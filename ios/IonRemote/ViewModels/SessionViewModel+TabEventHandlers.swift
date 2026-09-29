import Foundation

// MARK: - Tab Event Handlers

extension SessionViewModel {

    @MainActor
    func handleTabClosed(tabId: String) {
        pendingCloseTabIds.remove(tabId)
        tabIdleSince.removeValue(forKey: tabId)
        tabs.removeAll { $0.id == tabId }
        tabIds.remove(tabId)
        // Clean up all conversation/engine state for this tab. The single
        // instance carries messages + workingMessage, so removing it drops
        // both.
        conversationInstances.removeValue(forKey: tabId)
        activeEngineInstance.removeValue(forKey: tabId)
        for key in engineDialogs.keys where key == tabId || key.hasPrefix("\(tabId):") {
            engineDialogs.removeValue(forKey: key)
        }
        // enginePinnedPrompt and activeTools are keyed by the bare tabId
        // (post-#256); the former compound-key sweeps iterated the whole map for
        // keys that can no longer exist. Direct removal is sufficient.
        enginePinnedPrompt.removeValue(forKey: tabId)
        activeTools.removeValue(forKey: tabId)
        forgetTranscript(tabId: tabId)
        // Guided Questions are tab-scoped; a closed tab has no wizard to show.
        questionsStore.removeTab(tabId)
        // Drafts are local-only state — clean them up when the tab is closed
        // (don't survive tab close; do survive disconnect / restart). One
        // unified bare-tabId draft store covers plain and engine tabs.
        clearTabDraft(tabId)
    }

    @MainActor
    func handleTabStatus(tabId: String, status: TabStatus, resync: Bool = false) {
        if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            tabs[idx].status = status
            if resync {
                deriveActiveTools(tabId: tabId)
                if status == .running || status == .connecting {
                    tabIdleSince.removeValue(forKey: tabId)
                } else if tabIdleSince[tabId] == nil {
                    tabIdleSince[tabId] = Date()
                }
                DiagnosticLog.log("tab status resync applied", tag: "session.tabevents", fields: [
                    "tab_id": String(tabId.prefix(16)),
                    "status": status.rawValue
                ])
                return
            }
            if status == .running {
                // A new task started — any previous ExitPlanMode/AskUserQuestion
                // entries are stale (plan was implemented or user moved on).
                tabs[idx].permissionQueue.removeAll {
                    $0.toolName == "ExitPlanMode" || $0.toolName == "AskUserQuestion"
                }
                // RC-19: a new run means the tab may raise a genuinely NEW plan/
                // question card. dismissedLiveSpecialTabs records that a SPECIFIC
                // card was dismissed, not "never show a special card on this tab
                // again" — clear it so the next card (delivered via snapshot/
                // restore, not the live push) is not wrongly stripped.
                dismissedLiveSpecialTabs.remove(tabId)
                tabs[idx].lastRunDurationMs = nil
                tabs[idx].lastRunReason = nil
                for key in dismissedLiveSpecialTabs where key.hasPrefix("\(tabId):") {
                    dismissedLiveSpecialTabs.remove(key)
                }
            }
            if status == .idle || status == .completed || status == .failed || status == .dead {
                // Preserve ExitPlanMode/AskUserQuestion entries -- desktop auto-allows
                // these but iOS needs them for plan card UI and status indicators
                tabs[idx].permissionQueue.removeAll {
                    $0.toolName != "ExitPlanMode" && $0.toolName != "AskUserQuestion"
                }
            }
        }
        // The running-tools list follows the run: the transcript's running tool
        // rows while it runs, nothing once it stops.
        deriveActiveTools(tabId: tabId)
        // Track idle-since timestamp for sidebar display
        if status == .running || status == .connecting {
            tabIdleSince.removeValue(forKey: tabId)
        } else if tabIdleSince[tabId] == nil {
            tabIdleSince[tabId] = Date()
        }
    }

    @MainActor
    func handleTaskComplete(
        tabId: String,
        durationMs: Int? = nil,
        reason: TaskCompletionReason? = nil
    ) {
        mutateEngineInstance(tabId: tabId, instanceId: nil) { instance in
            instance.statusFields?.completionReason = reason
        }
        DiagnosticLog.log("task completion applied", tag: "session", fields: [
            "tab_id": String(tabId.prefix(8)),
            "duration_ms": durationMs.map(String.init) ?? "absent",
            "reason": reason?.logValue ?? "absent"
        ])

        if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            tabs[idx].status = .completed
            tabs[idx].lastRunDurationMs = durationMs
            tabs[idx].lastRunReason = reason
            // Preserve ExitPlanMode/AskUserQuestion entries for plan card UI
            tabs[idx].permissionQueue.removeAll {
                $0.toolName != "ExitPlanMode" && $0.toolName != "AskUserQuestion"
            }
        }
        deriveActiveTools(tabId: tabId)
        tabIdleSince[tabId] = Date()

        // TTS: speak the last assistant row of the transcript.
        let msgs = conversationMessages(tabId)
        let spoken = msgs.last(where: {
            $0.role == .assistant && !$0.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        })
        DiagnosticLog.log("voice tts task complete", tag: "session.voice", fields: [
            "tab_id": String(tabId.prefix(8)),
            "max": String(msgs.count)
        ])
        if let spoken, spoken.content.trimmingCharacters(in: .whitespacesAndNewlines).count > 20 {
            DiagnosticLog.log("voice tts speaking", tag: "session.voice", fields: [
                "count": String(spoken.content.count)
            ])
            voiceService.speak(text: spoken.content, messageId: spoken.id, tabId: tabId)
        } else {
            DiagnosticLog.log("voice tts not speaking", tag: "session.voice", fields: [
                "count": spoken.map { String($0.content.count) } ?? "nil"
            ])
        }
    }

    /// Apply a lightweight tab-row metadata delta from `desktop_tab_meta`.
    /// All fields are optional — only non-nil values are applied. Called on
    /// event-driven pushes (title change, cost update, group change, pill
    /// color/icon change) and on the desktop's poll-tick volatile push
    /// (lastActivityAt / lastMessage / messageCount — B6-1)
    /// so the tab list AND the staleness-heal signal stay current without a
    /// full snapshot reship per streamed delta.
    ///
    /// totalCostUsd is the legacy parameter name preserved so call sites don't
    /// need a coordinated rename. Internally it is stored as runCostUsd (the
    /// canonical field after the Commit 2 engine wire rename).
    ///
    /// pillColor uses a double optional: outer nil means omitted and
    /// leaves current state untouched; outer non-nil carries a value or an
    /// explicit clear (inner nil).
    @MainActor
    func handleTabMeta(tabId: String, title: String?, totalCostUsd: Double?, lastActivityAt: Double? = nil, lastMessageAt: Double? = nil, lastMessage: String? = nil, messageCount: Int? = nil, pillColor: String?? = nil) {
        guard let idx = tabs.firstIndex(where: { $0.id == tabId }) else {
            DiagnosticLog.log("tab meta tab not found", tag: "session", level: .debug, fields: [
                "tab_id": String(tabId.prefix(8))
            ])
            return
        }
        var changed = false
        if let title, title != tabs[idx].title {
            tabs[idx].title = title
            changed = true
        }
        if let totalCostUsd {
            // Store as runCostUsd (canonical) and keep totalCostUsd in sync.
            tabs[idx].runCostUsd = totalCostUsd
            tabs[idx].totalCostUsd = totalCostUsd
            changed = true
        }
        if let pillColor, pillColor != tabs[idx].pillColor {
            tabs[idx].pillColor = pillColor
            changed = true
        }
        // Volatile conversation fields (B6-1). The snapshot no longer re-ships
        // when only these tick, so this delta is their live carrier between
        // structural snapshots.
        if let lastActivityAt {
            tabs[idx].lastActivityAt = lastActivityAt
            changed = true
        }
        if let lastMessageAt {
            tabs[idx].lastMessageAt = lastMessageAt
            changed = true
        }
        if let lastMessage, lastMessage != tabs[idx].lastMessage {
            tabs[idx].lastMessage = lastMessage
            changed = true
        }
        if let messageCount {
            tabs[idx].messageCount = messageCount
            changed = true
        }
        if changed {
            DiagnosticLog.log("tab meta applied delta", tag: "session", level: .debug, fields: [
                "tab_id": String(tabId.prefix(8)),
                "reason": title ?? "-",
                "cost_usd": totalCostUsd.map { String(format: "%.4f", $0) } ?? "-",
                "count": messageCount.map(String.init) ?? "-"
            ])
        }
    }
}

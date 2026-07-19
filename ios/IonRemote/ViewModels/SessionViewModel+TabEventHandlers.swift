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
        // instance carries messages + liveText + workingMessage +
        // thinkingMessageId, so removing it drops all of them.
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
        conversationLoaded.remove(tabId)
        loadingConversation.remove(tabId)
        // Drafts are local-only state — clean them up when the tab is closed
        // (don't survive tab close; do survive disconnect / restart). One
        // unified bare-tabId draft store covers plain and engine tabs.
        clearTabDraft(tabId)
    }

    @MainActor
    func handleTabStatus(tabId: String, status: TabStatus) {
        if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            let previousStatus = tabs[idx].status
            tabs[idx].status = status
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
                for key in dismissedLiveSpecialTabs where key.hasPrefix("\(tabId):") {
                    dismissedLiveSpecialTabs.remove(key)
                }
            }
            if status == .idle || status == .completed || status == .failed || status == .dead {
                // Capture preview from liveText before clearing — if tabStatus
                // arrives before taskComplete, this preserves the lastMessage.
                let text = liveText(tabId)
                if !text.isEmpty {
                    tabs[idx].lastMessage = String(text.suffix(64))
                        .replacingOccurrences(of: "\n", with: " ")
                }
                clearLiveText(tabId: tabId)
                // Preserve ExitPlanMode/AskUserQuestion entries -- desktop auto-allows
                // these but iOS needs them for plan card UI and status indicators
                tabs[idx].permissionQueue.removeAll {
                    $0.toolName != "ExitPlanMode" && $0.toolName != "AskUserQuestion"
                }
                // Clear active tools for this tab. activeTools is keyed by the
                // bare tabId (post-#256), so no compound-key sweep is needed.
                activeTools.removeValue(forKey: tabId)
                // RC-21: the activeTools MAP is cleared above, but the transcript
                // tool ROWS still read .running if their tool_end was dropped
                // (transport gap / cancel). Grouping then shows an eternal spinner
                // / "Running tools…" that never resolves. Mirror the map clear onto
                // the rows: demote any still-running tool row to completed on a
                // terminal transition. A genuine failure surfaces via a later
                // tool_end (isError) or history reload.
                finalizeRunningToolRows(tabId: tabId)
            }
            // One-shot post-run heal: when a tab transitions out of .running or
            // .connecting into a terminal/idle state, the local transcript may
            // have missed the final deltas (tool_end, last assistant text chunk).
            // Fire a reconcile now that streaming has stopped; the fingerprint
            // and debounce guards in maybeReconcileStaleConversation ensure this
            // only triggers a reload if there is a real divergence, and at most
            // once per reconcileDebounce window.
            if (previousStatus == .running || previousStatus == .connecting)
                && (status == .idle || status == .completed || status == .failed || status == .dead) {
                DiagnosticLog.log("post-run heal check", tag: "session.tabevents", fields: [
                    "tab_id": String(tabId.prefix(16)),
                    "status": status.rawValue,
                    "reason": previousStatus.rawValue
                ])
                maybeReconcileStaleConversation(tab: tabs[idx])
            }
        }
        // Track idle-since timestamp for sidebar display
        if status == .running || status == .connecting {
            tabIdleSince.removeValue(forKey: tabId)
        } else if tabIdleSince[tabId] == nil {
            tabIdleSince[tabId] = Date()
        }
    }

    @MainActor
    func handleTaskComplete(tabId: String) {
        // Capture liveText before it's cleared. liveText is the accumulator for
        // the legacy desktop_text_chunk path (only an OLDER desktop build emits
        // it; the current desktop forwards assistant text as desktop_text_delta,
        // which lands in the instance messages). It is kept here as a TTS
        // fallback for that legacy path — the transcript itself renders from the
        // instance messages, which the desktop_text_delta path already populated.
        let capturedLiveText = liveText(tabId)

        var previousStatus: TabStatus? = nil
        if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            previousStatus = tabs[idx].status
            tabs[idx].status = .completed
            // Preserve ExitPlanMode/AskUserQuestion entries for plan card UI
            tabs[idx].permissionQueue.removeAll {
                $0.toolName != "ExitPlanMode" && $0.toolName != "AskUserQuestion"
            }
            // Capture final preview from accumulated live text before it's cleared
            if !capturedLiveText.isEmpty {
                tabs[idx].lastMessage = String(capturedLiveText.suffix(64))
                    .replacingOccurrences(of: "\n", with: " ")
            }
        }
        clearLiveText(tabId: tabId)
        // activeTools is keyed by the bare tabId (post-#256); no compound sweep.
        activeTools.removeValue(forKey: tabId)
        // RC-21: demote any tool row still stuck .running (dropped tool_end) so a
        // completed turn doesn't show an eternal spinner. Mirrors the activeTools
        // clear above onto the transcript rows.
        finalizeRunningToolRows(tabId: tabId)
        tabIdleSince[tabId] = Date()

        // TTS: try the unified conversation messages → liveText. Both the
        // engine_text_delta path and the message_added path now land in the
        // single instance, so one read covers both; liveText is the
        // text_chunk (relay) fallback.
        let convLoaded = conversationLoaded.contains(tabId)
        let msgs = conversationMessages(tabId)
        DiagnosticLog.log("voice tts task complete", tag: "session.voice", fields: [
            "tab_id": String(tabId.prefix(8)),
            "status": String(convLoaded),
            "count": String(capturedLiveText.count),
            "max": String(msgs.count)
        ])
        let spokenInfo: (text: String, messageId: String?)? = {
            // 1. unified instance messages (engine_text_delta + message_added)
            if let last = msgs.last(where: { $0.role == .assistant }),
               !last.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return (last.content, last.id)
            }
            // 2. liveText (text_chunk path — captured before clear) — no ID
            if !capturedLiveText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return (capturedLiveText, nil)
            }
            return nil
        }()

        if let info = spokenInfo,
           info.text.trimmingCharacters(in: .whitespacesAndNewlines).count > 20 {
            DiagnosticLog.log("voice tts speaking", tag: "session.voice", fields: [
                "count": String(info.text.count)
            ])
            voiceService.speak(text: info.text, messageId: info.messageId, tabId: tabId)
        } else {
            DiagnosticLog.log("voice tts not speaking", tag: "session.voice", fields: [
                "count": spokenInfo == nil ? "nil" : String(spokenInfo!.text.count)
            ])
        }

        // RC-24: fire the one-shot post-run heal on the taskComplete settle path
        // too. handleTabStatus heals on a running→idle transition, but a run that
        // settles via taskComplete without a paired running→idle tabStatus event
        // otherwise skipped the immediate heal and waited for the next 5s snapshot.
        // The fingerprint + debounce guards in maybeReconcileStaleConversation
        // make this a no-op unless there is a real divergence.
        if previousStatus == .running || previousStatus == .connecting,
           let tab = tabs.first(where: { $0.id == tabId }) {
            maybeReconcileStaleConversation(tab: tab)
        }
    }

    /// Apply a lightweight tab-row metadata delta from `desktop_tab_meta`.
    /// All fields are optional — only non-nil values are applied. Called on
    /// event-driven pushes (title change, cost update, group change) and on
    /// the desktop's poll-tick volatile push (convFingerprint /
    /// lastActivityAt / lastMessage / messageCount — B6-1) so the tab list
    /// AND the staleness-heal signal stay current without a full snapshot
    /// reship per streamed delta.
    ///
    /// totalCostUsd is the legacy parameter name preserved so call sites don't
    /// need a coordinated rename. Internally it is stored as runCostUsd (the
    /// canonical field after the Commit 2 engine wire rename).
    @MainActor
    func handleTabMeta(tabId: String, title: String?, totalCostUsd: Double?, groupId: String?, convFingerprint: String? = nil, lastActivityAt: Double? = nil, lastMessage: String? = nil, messageCount: Int? = nil) {
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
        if let groupId, groupId != tabs[idx].groupId {
            tabs[idx].groupId = groupId
            changed = true
        }
        // Volatile conversation fields (B6-1). The snapshot no longer re-ships
        // when only these tick, so this delta is the live carrier for the heal
        // fingerprint between structural snapshots.
        var fingerprintChanged = false
        if let convFingerprint, convFingerprint != tabs[idx].convFingerprint {
            tabs[idx].convFingerprint = convFingerprint
            fingerprintChanged = true
            changed = true
        }
        if let lastActivityAt {
            tabs[idx].lastActivityAt = lastActivityAt
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
                "status": groupId ?? "-",
                "count": messageCount.map(String.init) ?? "-"
            ])
        }
        // A fresh fingerprint is the staleness signal the snapshot used to
        // carry. Run the same heal check the snapshot path runs — its internal
        // guards (streaming suppression, loaded/loading gates, in-sync
        // fingerprint match, per-tab debounce) make this a no-op unless the
        // local transcript genuinely diverged.
        if fingerprintChanged {
            maybeReconcileStaleConversation(tab: tabs[idx])
        }
    }

    /// RC-21: demote any tool row still marked `.running` to `.completed` when the
    /// tab reaches a terminal state. A dropped tool_end (transport gap / cancel)
    /// otherwise leaves the row spinning forever and grouping renders an eternal
    /// "Running tools…". Called from every terminal transition (handleTabStatus
    /// idle/completed/failed/dead and handleTaskComplete). A row whose real
    /// outcome was an error is corrected by a later tool_end or history reload.
    @MainActor
    func finalizeRunningToolRows(tabId: String) {
        mutateConversationMessages(tabId: tabId) { msgs in
            for i in msgs.indices where msgs[i].role == .tool && msgs[i].toolStatus == .running {
                msgs[i].toolStatus = .completed
            }
        }
    }
}

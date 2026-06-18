import Foundation

// MARK: - Tab Event Handlers

extension SessionViewModel {

    @MainActor
    func handleTabClosed(tabId: String) {
        pendingCloseTabIds.remove(tabId)
        tabIdleSince.removeValue(forKey: tabId)
        tabs.removeAll { $0.id == tabId }
        tabIds.remove(tabId)
        liveText.removeValue(forKey: tabId)
        // Clean up all engine state for this tab
        conversationInstances.removeValue(forKey: tabId)
        activeEngineInstance.removeValue(forKey: tabId)
        for key in engineWorkingMessages.keys where key == tabId || key.hasPrefix("\(tabId):") {
            engineWorkingMessages.removeValue(forKey: key)
        }
        for key in engineDialogs.keys where key == tabId || key.hasPrefix("\(tabId):") {
            engineDialogs.removeValue(forKey: key)
        }
        for key in enginePinnedPrompt.keys where key == tabId || key.hasPrefix("\(tabId):") {
            enginePinnedPrompt.removeValue(forKey: key)
        }
        for key in activeTools.keys where key.hasPrefix("\(tabId):") || key == tabId {
            activeTools.removeValue(forKey: key)
        }
        for key in thinkingInProgress.keys where key == tabId || key.hasPrefix("\(tabId):") {
            thinkingInProgress.removeValue(forKey: key)
        }
        engineConversationLoaded = engineConversationLoaded.filter { $0 != tabId && !$0.hasPrefix("\(tabId):") }
        // Drafts are local-only state — clean them up when the tab is closed
        // (don't survive tab close; do survive disconnect / restart).
        clearTabDraft(tabId)
        clearEngineDrafts(forTab: tabId)
    }

    @MainActor
    func handleTabStatus(tabId: String, status: TabStatus) {
        if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            tabs[idx].status = status
            if status == .running {
                // A new task started — any previous ExitPlanMode/AskUserQuestion
                // entries are stale (plan was implemented or user moved on).
                tabs[idx].permissionQueue.removeAll {
                    $0.toolName == "ExitPlanMode" || $0.toolName == "AskUserQuestion"
                }
            }
            if status == .idle || status == .completed || status == .failed || status == .dead {
                // Capture preview from liveText before clearing — if tabStatus
                // arrives before taskComplete, this preserves the lastMessage.
                if let text = liveText[tabId], !text.isEmpty {
                    tabs[idx].lastMessage = String(text.suffix(64))
                        .replacingOccurrences(of: "\n", with: " ")
                }
                liveText.removeValue(forKey: tabId)
                // Preserve ExitPlanMode/AskUserQuestion entries -- desktop auto-allows
                // these but iOS needs them for plan card UI and status indicators
                tabs[idx].permissionQueue.removeAll {
                    $0.toolName != "ExitPlanMode" && $0.toolName != "AskUserQuestion"
                }
                // Clear active tools for this tab (both bare tabId and compound keys)
                activeTools.removeValue(forKey: tabId)
                for key in activeTools.keys where key.hasPrefix("\(tabId):") {
                    activeTools.removeValue(forKey: key)
                }
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
        // Capture liveText before it's cleared — the relay sends assistant
        // output as text_chunk (which populates liveText) rather than
        // engine_text_delta (which populates engineMessages), so liveText
        // is the only reliable source for voice readback.
        let capturedLiveText = liveText[tabId]

        if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            tabs[idx].status = .completed
            // Preserve ExitPlanMode/AskUserQuestion entries for plan card UI
            tabs[idx].permissionQueue.removeAll {
                $0.toolName != "ExitPlanMode" && $0.toolName != "AskUserQuestion"
            }
            // Capture final preview from accumulated live text before it's cleared
            if let text = capturedLiveText, !text.isEmpty {
                tabs[idx].lastMessage = String(text.suffix(64))
                    .replacingOccurrences(of: "\n", with: " ")
            }
        }
        liveText.removeValue(forKey: tabId)
        activeTools.removeValue(forKey: tabId)
        for key in activeTools.keys where key.hasPrefix("\(tabId):") {
            activeTools.removeValue(forKey: key)
        }
        tabIdleSince[tabId] = Date()

        // TTS: try instance messages → conversation messages → liveText
        let convLoaded = conversationLoaded.contains(tabId)
        let engineMsgCount = engineInstance(tabId: tabId, instanceId: activeEngineInstance[tabId])?.messages.count ?? -1
        DiagnosticLog.log("VOICE-TTS: taskComplete tabId=\(tabId.prefix(8)) convLoaded=\(convLoaded) liveText=\(capturedLiveText?.count ?? -1) msgs=\(messages[tabId]?.count ?? -1) engineMsgs=\(engineMsgCount)")
        let spokenInfo: (text: String, messageId: String?)? = {
            // 1. instance.messages (engine_text_delta path) — no stable message ID
            if let last = engineInstance(tabId: tabId, instanceId: activeEngineInstance[tabId])?.messages.last(where: { $0.role == .assistant }),
               !last.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return (last.content, nil)
            }
            // 2. conversation messages (message_added path) — has stable ID
            if let last = messages[tabId]?.last(where: { $0.role == .assistant }),
               !last.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return (last.content, last.id)
            }
            // 3. liveText (text_chunk path — captured before clear) — no ID
            if let text = capturedLiveText,
               !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return (text, nil)
            }
            return nil
        }()

        if let info = spokenInfo,
           info.text.trimmingCharacters(in: .whitespacesAndNewlines).count > 20 {
            DiagnosticLog.log("VOICE-TTS: speaking \(info.text.count) chars")
            voiceService.speak(text: info.text, messageId: info.messageId, tabId: tabId)
        } else {
            DiagnosticLog.log("VOICE-TTS: not speaking — text=\(spokenInfo == nil ? "nil" : "\(spokenInfo!.text.count) chars")")
        }
    }
}

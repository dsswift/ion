import Foundation
import os

private let ionLog = Logger(subsystem: "com.sprague.ion.mobile", category: "engine")

// MARK: - Snapshot Handling

extension SessionViewModel {

    @MainActor
    func handleSnapshot(snapshotTabs: [RemoteTabState], recentDirs: [String], groupMode: String?, groups: [RemoteTabGroup]?, preferredModel: String? = nil, engineDefaultModel: String? = nil, availableModels: [RemoteModelEntry]? = nil) {
        DiagnosticLog.log("SNAP: received tabs=\(snapshotTabs.count) dirs=\(recentDirs.count) groupMode=\(groupMode ?? "nil") models=\(availableModels?.count ?? 0)")
        // Log any tabs that arrive with a non-empty permission queue so we can
        // confirm the blue dot has the data it needs at relaunch.
        for t in snapshotTabs where !t.permissionQueue.isEmpty {
            let tools = t.permissionQueue.map { "\($0.toolName)(id=\($0.questionId.prefix(12)))" }.joined(separator: ", ")
            DiagnosticLog.log("SNAP: tab=\(t.id.prefix(8)) status=\(t.status.rawValue) queue=[\(tools)]")
        }
        for t in snapshotTabs where t.isEngine == true && t.permissionQueue.isEmpty {
            if t.status == .completed || t.status == .idle {
                DiagnosticLog.log("SNAP: engine tab=\(t.id.prefix(8)) status=\(t.status.rawValue) queue=EMPTY (no denials promoted)")
            }
        }
        if connectionState != .connected {
            DiagnosticLog.log("SNAP: connected (was \(connectionState))")
            connectionState = .connected
            cancelReconnectSafetyTimer()
        }
        connectionQuality.transportState = transport?.state ?? .disconnected
        if !recentDirs.isEmpty {
            recentDirectories = recentDirs
        }
        // Update tab group mode and groups from desktop
        if let mode = groupMode {
            tabGroupMode = mode
        }
        if let grps = groups {
            tabGroups = grps
        }
        if let pm = preferredModel {
            self.preferredModel = pm
        }
        if let edm = engineDefaultModel {
            self.engineDefaultModel = edm
        }
        if let models = availableModels, !models.isEmpty {
            self.availableModels = models
        }
        // Filter out tabs that iOS requested to close but hasn't received
        // tab_closed confirmation for yet. Without this, the snapshot
        // resurrects tabs that the user just swiped away.
        let filteredTabs = snapshotTabs.filter { !pendingCloseTabIds.contains($0.id) }
        // Preserve locally-injected permission queue entries that arrived
        // via permission_request events. Snapshots pull the queue from the
        // desktop renderer, which may have already auto-allowed tools like
        // AskUserQuestion/ExitPlanMode (empty queue), while iOS still needs
        // to show the card until the user taps an answer.
        var merged = filteredTabs
        for i in merged.indices {
            let tabId = merged[i].id

            // Strip ExitPlanMode/AskUserQuestion entries from the snapshot
            // queue if the user already dismissed the card on this tab.
            // The 5-second snapshot polling can re-inject stale entries
            // from the desktop's permissionDenied before it's cleared.
            if dismissedLiveSpecialTabs.contains(tabId) {
                merged[i].permissionQueue.removeAll {
                    $0.toolName == "ExitPlanMode" || $0.toolName == "AskUserQuestion"
                }
            }

            if let existing = tabs.first(where: { $0.id == tabId }),
               !existing.permissionQueue.isEmpty {
                // Keep existing local queue entries that aren't in the snapshot
                let snapshotIds = Set(merged[i].permissionQueue.map(\.questionId))
                let isRunning = merged[i].status == .running
                let localOnly = existing.permissionQueue.filter { entry in
                    if snapshotIds.contains(entry.questionId) { return false }
                    // Don't re-inject stale plan/question cards once a new task is running
                    if isRunning && (entry.toolName == "ExitPlanMode" || entry.toolName == "AskUserQuestion") {
                        return false
                    }
                    return true
                }
                merged[i].permissionQueue.append(contentsOf: localOnly)
                // Prefer local entry when it has richer data (e.g. planContent from live event)
                for local in existing.permissionQueue where snapshotIds.contains(local.questionId) {
                    if local.toolInput?["planContent"]?.value as? String != nil,
                       let idx = merged[i].permissionQueue.firstIndex(where: { $0.questionId == local.questionId }),
                       merged[i].permissionQueue[idx].toolInput?["planContent"]?.value as? String == nil {
                        merged[i].permissionQueue[idx] = local
                    }
                }
            }
        }
        // Always prefer locally-tracked lastMessage over snapshot values.
        // Real-time textChunk/messageAdded events update lastMessage on iOS
        // faster than the 5-second snapshot poll, so the local value is
        // always equal or fresher. The snapshot value is only used for
        // initial population (when no local value exists yet).
        for i in merged.indices {
            if let existing = tabs.first(where: { $0.id == merged[i].id }),
               existing.lastMessage != nil {
                merged[i].lastMessage = existing.lastMessage
            }
        }
        tabs = merged
        tabIds = Set(merged.map(\.id))
        // Reconcile idle-since timestamps with snapshot state
        let mergedIds = Set(merged.map(\.id))
        for tab in merged {
            if tab.status == .running || tab.status == .connecting {
                tabIdleSince.removeValue(forKey: tab.id)
            } else if tabIdleSince[tab.id] == nil {
                // Prefer the desktop-provided activity timestamp over local Date()
                if let ms = tab.lastActivityAt, ms > 0 {
                    tabIdleSince[tab.id] = Date(timeIntervalSince1970: ms / 1000.0)
                } else {
                    tabIdleSince[tab.id] = Date()
                }
            }
        }
        // Clean up idle-since entries for tabs no longer present
        for tabId in tabIdleSince.keys where !mergedIds.contains(tabId) {
            tabIdleSince.removeValue(forKey: tabId)
        }
        // Clean up drafts for tabs no longer present in the snapshot
        // (tab was closed remotely; drafts are scoped to live tabs).
        for tabId in draftInputByTab.keys where !mergedIds.contains(tabId) {
            clearTabDraft(tabId)
            clearEngineDrafts(forTab: tabId)
        }
        // Also catch engine-only draft keys whose tabId is no longer present
        // (in case the tab had no plain `draftInput` but did have engine drafts).
        let orphanEngineTabIds = Set(engineDraftInputByKey.keys.compactMap { key -> String? in
            guard let sep = key.firstIndex(of: ":") else { return nil }
            let tid = String(key[..<sep])
            return mergedIds.contains(tid) ? nil : tid
        })
        for tabId in orphanEngineTabIds {
            clearEngineDrafts(forTab: tabId)
        }
        // Populate terminal state from snapshot tab data
        for tab in merged {
            if tab.isTerminalOnly == true, let instances = tab.terminalInstances {
                terminalInstances[tab.id] = instances
                activeTerminalInstance[tab.id] = tab.activeTerminalInstanceId ?? instances.first?.id
            }
            // Populate engine instance state from snapshot tab data
            if tab.isEngine == true, let instances = tab.engineInstances {
                // Carry waitingState through to the local model so
                // EngineInstanceBar can render its per-instance status
                // dot. Desktop sends nil for no-state, "question" for
                // AskUserQuestion, "plan-ready" for ExitPlanMode.
                engineInstances[tab.id] = instances.map {
                    EngineInstanceInfo(id: $0.id, label: $0.label, waitingState: $0.waitingState)
                }
                activeEngineInstance[tab.id] = tab.activeEngineInstanceId ?? instances.first?.id
                ionLog.info("snapshot: engine tab \(tab.id.prefix(8)), instances=\(instances.map(\.id)), active=\(tab.activeEngineInstanceId ?? "nil")")
                // Pre-load engine conversation history for all engine tabs
                loadEngineConversation(tabId: tab.id)
            }
        }
        // Re-send in-flight conversation loads that may have been dropped.
        for tabId in loadingConversation {
            send(.loadConversation(tabId: tabId, before: conversationCursor[tabId]))
        }

        // Cache layout for the active device so reconnects restore it.
        if let deviceId = activeDevice?.id {
            if !hasConnectedBefore {
                hasConnectedBefore = true
                UserDefaults.standard.set(true, forKey: "hasConnectedBefore")
            }
            LayoutCache.save(
                deviceId: deviceId,
                tabs: merged,
                tabGroupMode: tabGroupMode,
                tabGroups: tabGroups,
                recentDirectories: recentDirectories
            )
        }

        // Send voice configuration so the desktop knows current voice settings.
        sendVoiceConfig()
    }
}

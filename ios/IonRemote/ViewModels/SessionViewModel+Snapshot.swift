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
        for t in snapshotTabs where t.hasEngineExtension == true && t.permissionQueue.isEmpty {
            if t.status == .completed || t.status == .idle {
                DiagnosticLog.log("SNAP: engine tab=\(t.id.prefix(8)) status=\(t.status.rawValue) queue=EMPTY (no denials promoted)")
            }
        }
        if connectionState != .connected {
            DiagnosticLog.log("SNAP: connected (was \(connectionState))")
            connectionState = .connected
            cancelReconnectSafetyTimer()
            // The transport is now proven usable (we just got a real
            // snapshot back from the desktop), so release any commands
            // that were deferred via `runWhenConnected` during the
            // reconnect window — e.g. the scene-resume git refresh and
            // focus report. Order matters: we flip state first so that
            // a drained block which re-checks `connectionState` (or
            // calls `runWhenConnected` again) sees `.connected` and
            // runs inline rather than re-queueing.
            drainPendingOnConnected()
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
            //
            // Dismissals come in two scopes (see dismissSpecialPermission):
            //   - bare tabId — CLI tabs and legacy entries without
            //     instance identity; strips every special entry on the tab.
            //   - "tabId:instanceId" — engine sub-tab dismissals; strips
            //     only entries owned by that instance so a sibling
            //     sub-tab's pending card survives the sweep.
            merged[i].permissionQueue.removeAll { entry in
                guard entry.toolName == "ExitPlanMode" || entry.toolName == "AskUserQuestion" else {
                    return false
                }
                if dismissedLiveSpecialTabs.contains(tabId) { return true }
                if let instanceId = entry.instanceId,
                   dismissedLiveSpecialTabs.contains("\(tabId):\(instanceId)") {
                    return true
                }
                return false
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
            if tab.hasEngineExtension == true, let instances = tab.conversationInstances {
                // Merge snapshot-projected fields onto existing instances so
                // we preserve runtime conversation state across snapshot
                // ticks. ConversationInstanceInfo carries two flavors of state:
                //
                //   - Snapshot-projected (Codable): id, label, waitingState,
                //     isRunning, runningAgentCount, modelFallback. These are
                //     authoritative from the desktop snapshot every tick.
                //   - Runtime-only (excluded from Codable): messages,
                //     agentStates, statusFields, modelOverride. These are
                //     populated by live events / loadEngineConversation and
                //     must survive the snapshot reassignment.
                //
                // Previously this code did `conversationInstances[tab.id] =
                // instances.map { ConversationInstanceInfo(id:label:waitingState:) }`
                // which constructed fresh instances with default-empty
                // runtime state — wiping messages every snapshot. That was
                // masked by an unconditional `loadEngineConversation` call
                // below that immediately refetched the history (and caused
                // the every-5s flicker). With the guard in place, the wipe
                // is no longer masked and the conversation would disappear
                // a few seconds after open. The merge below fixes the root
                // cause: preserve runtime state, update snapshot fields.
                let existing = conversationInstances[tab.id] ?? []
                conversationInstances[tab.id] = instances.map { snap in
                    if var prior = existing.first(where: { $0.id == snap.id }) {
                        prior.label = snap.label
                        prior.waitingState = snap.waitingState
                        prior.isRunning = snap.isRunning
                        prior.runningAgentCount = snap.runningAgentCount
                        prior.modelFallback = snap.modelFallback
                        return prior
                    }
                    // New instance not seen before — use the snapshot value
                    // as-is; runtime fields default to their empty values
                    // and will be populated by loadEngineConversation /
                    // live events.
                    return snap
                }
                activeEngineInstance[tab.id] = tab.activeConversationInstanceId ?? instances.first?.id
                ionLog.info("snapshot: engine tab \(tab.id.prefix(8)), instances=\(instances.map(\.id)), active=\(tab.activeConversationInstanceId ?? "nil")")
                // Pre-load engine conversation history for engine tabs we
                // haven't loaded yet. Guarded against `engineConversationLoaded`
                // so the snapshot handler — which runs on every ~5s snapshot
                // delivery — does not re-issue a `loadEngineConversation`
                // command for tabs that already have history. Without this
                // guard the desktop replies with `engineConversationHistory`
                // every snapshot, and the event handler replaces the entire
                // `messages` array (SessionViewModel+EventHandlers.swift:256),
                // causing the conversation view to flicker every 5s — most
                // visible in engine/extension tabs where this code path runs.
                // The compound-key composition matches the event handler at
                // SessionViewModel+EventHandlers.swift:253 so the same key
                // marks "loaded" here and is checked there.
                let activeInstanceId = activeEngineInstance[tab.id]
                let loadedKey = activeInstanceId.map { "\(tab.id):\($0)" } ?? tab.id
                if !engineConversationLoaded.contains(loadedKey) {
                    DiagnosticLog.log("SNAP: engine conv not loaded for key=\(loadedKey.prefix(16)) — firing loadEngineConversation")
                    loadEngineConversation(tabId: tab.id)
                } else {
                    DiagnosticLog.log("SNAP: engine conv already loaded key=\(loadedKey.prefix(16)) — skipping")
                }
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

import Foundation
import os

private let ionLog = Logger(subsystem: "com.sprague.ion.mobile", category: "engine")

// MARK: - Event Listening

extension SessionViewModel {

    func startListening() {
        eventTask?.cancel()
        flushTask?.cancel()

        // Collector: read events from transport and enqueue into batcher
        eventTask = Task { [weak self] in
            guard let self, let transport = self.transport else { return }

            for await event in transport.events {
                guard !Task.isCancelled else { break }
                await self.eventBatcher.enqueue(event)
            }

            // Stream ended -- flush any remaining events then wipe state
            let remaining = await self.eventBatcher.drain()
            await MainActor.run {
                for event in remaining {
                    self.handleEvent(event)
                }
                self.wipeTransientState()
            }
        }

        // Flusher: drain batched events every ~16ms and process on MainActor
        flushTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(16))
                guard !Task.isCancelled, let self else { break }

                let batch = await self.eventBatcher.drain()
                if !batch.isEmpty {
                    await MainActor.run {
                        for event in batch {
                            self.handleEvent(event)
                        }
                    }
                }
            }
        }
    }

    @MainActor
    func handleEvent(_ event: RemoteEvent) {
        print("[Ion] handleEvent: \(event)")
        switch event {
        case .unpair:
            handleUnpair()

        case .relayConfig(let relayUrl, let relayApiKey):
            handleRelayConfig(relayUrl: relayUrl, relayApiKey: relayApiKey)

        case .transportReconnecting:
            if connectionState == .connected {
                connectionState = .reconnecting
            }

        case .peerDisconnected:
            // Tear down and let the auto-retry in IonRemoteApp reconnect.
            // connect() creates a relay-capable transport and starts Bonjour,
            // so LAN auto-upgrade still works when the desktop comes back.
            disconnect()

        case .snapshot(let snapshotTabs, let recentDirs, let snapshotGroupMode, let snapshotGroups):
            handleSnapshot(snapshotTabs: snapshotTabs, recentDirs: recentDirs, groupMode: snapshotGroupMode, groups: snapshotGroups)

        case .tabCreated(let tab):
            if !tabs.contains(where: { $0.id == tab.id }) {
                tabs.append(tab)
                tabIds.insert(tab.id)
            }
            pendingNavigationTabId = tab.id

        case .tabClosed(let tabId):
            handleTabClosed(tabId: tabId)

        case .tabStatus(let tabId, let status):
            handleTabStatus(tabId: tabId, status: status)

        case .textChunk(let tabId, let text):
            liveText[tabId, default: ""] += text
            // Update tab preview for the tab list (shows most recent text)
            if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
                let preview = liveText[tabId, default: ""]
                tabs[idx].lastMessage = String(preview.suffix(64))
                    .replacingOccurrences(of: "\n", with: " ")
            }
            guard !conversationLoaded.contains(tabId) else { break }

        case .toolCall(let tabId, let toolName, _):
            guard !conversationLoaded.contains(tabId) else { break }
            liveText[tabId, default: ""] += "\n> \(toolName)\n"

        case .toolResult(let tabId, _, let content, let isError):
            guard !conversationLoaded.contains(tabId) else { break }
            let prefix = isError ? "[error]" : "[ok]"
            let truncated = content.prefix(200)
            liveText[tabId, default: ""] += "\(prefix) \(truncated)\n"

        case .taskComplete(let tabId, _, _):
            handleTaskComplete(tabId: tabId)

        case .permissionRequest(let tabId, let questionId, let toolName, let toolInput, let options):
            handlePermissionRequest(tabId: tabId, questionId: questionId, toolName: toolName, toolInput: toolInput, options: options)

        case .permissionResolved(let tabId, let questionId):
            if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
                tabs[idx].permissionQueue.removeAll { $0.questionId == questionId }
            }

        case .conversationHistory(let tabId, let newMessages, let hasMore, let cursor):
            handleConversationHistory(tabId: tabId, newMessages: newMessages, hasMore: hasMore, cursor: cursor)

        case .messageAdded(let tabId, let message):
            handleMessageAdded(tabId: tabId, message: message)

        case .messageUpdated(let tabId, let messageId, let content, let toolStatus, let toolInput):
            handleMessageUpdated(tabId: tabId, messageId: messageId, content: content, toolStatus: toolStatus, toolInput: toolInput)

        case .queueUpdate(let tabId, let prompts):
            if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
                tabs[idx].queuedPrompts = prompts
            }

        case .error(let tabId, let message):
            guard !conversationLoaded.contains(tabId) else { break }
            liveText[tabId, default: ""] += "\n[error] \(message)\n"

        case .inputPrefill(let tabId, let text, let switchTo):
            handleInputPrefill(tabId: tabId, text: text, switchTo: switchTo)

        // Terminal events
        case .terminalOutput(let tabId, let instanceId, let data):
            TerminalOutputRouter.shared.route(tabId: tabId, instanceId: instanceId, data: data)

        case .terminalExit(let tabId, let instanceId, let exitCode):
            TerminalOutputRouter.shared.routeExit(tabId: tabId, instanceId: instanceId, exitCode: exitCode)

        case .terminalInstanceAdded(let tabId, let instance):
            terminalInstances[tabId, default: []].append(instance)

        case .terminalInstanceRemoved(let tabId, let instanceId):
            terminalInstances[tabId]?.removeAll { $0.id == instanceId }
            if activeTerminalInstance[tabId] == instanceId {
                activeTerminalInstance[tabId] = terminalInstances[tabId]?.first?.id
            }

        case .terminalSnapshot(let tabId, let instances, let activeInstanceId, let buffers):
            terminalInstances[tabId] = instances
            activeTerminalInstance[tabId] = activeInstanceId ?? instances.first?.id
            // Feed buffered scrollback to registered terminal views
            if let buffers {
                for (instanceId, data) in buffers {
                    TerminalOutputRouter.shared.feedBuffer(tabId: tabId, instanceId: instanceId, data: data)
                }
            }

        // Engine events (structured)
        case .engineAgentState(let tabId, let instanceId, let agents):
            let key = instanceId != nil ? "\(tabId):\(instanceId!)" : tabId
            engineAgentStates[key] = agents

        case .engineStatus(let tabId, let instanceId, let fields):
            let key = instanceId != nil ? "\(tabId):\(instanceId!)" : tabId
            engineStatusFields[key] = fields

        case .engineWorkingMessage(let tabId, let instanceId, let message):
            let key = instanceId != nil ? "\(tabId):\(instanceId!)" : tabId
            engineWorkingMessages[key] = message

        case .engineToolStart(let tabId, let instanceId, let toolName, let toolId):
            handleEngineToolStart(tabId: tabId, instanceId: instanceId, toolName: toolName, toolId: toolId)

        case .engineToolEnd(let tabId, let instanceId, let toolId, let result, let isError):
            handleEngineToolEnd(tabId: tabId, instanceId: instanceId, toolId: toolId, result: result, isError: isError)

        case .engineToolStalled(let tabId, let instanceId, let toolId, _, _):
            let key = instanceId != nil ? "\(tabId):\(instanceId!)" : tabId
            activeTools[key]?[toolId]?.isStalled = true

        case .engineError(let tabId, let instanceId, let message):
            handleEngineError(tabId: tabId, instanceId: instanceId, message: message)

        case .engineNotify(let tabId, let instanceId, let message, let level):
            handleEngineNotify(tabId: tabId, instanceId: instanceId, message: message, level: level)

        case .engineDialog(let tabId, let instanceId, let dialogId, let method, let title, let options, let defaultValue):
            let key = instanceId != nil ? "\(tabId):\(instanceId!)" : tabId
            engineDialogs[key] = EngineDialogInfo(dialogId: dialogId, method: method, title: title, options: options, defaultValue: defaultValue)

        case .engineDialogResolved(let tabId, let instanceId, _):
            let key = instanceId != nil ? "\(tabId):\(instanceId!)" : tabId
            engineDialogs[key] = nil

        case .engineTextDelta(let tabId, let instanceId, let text):
            handleEngineTextDelta(tabId: tabId, instanceId: instanceId, text: text)

        case .engineMessageEnd(let tabId, let instanceId, let inputTokens, _, let contextPercent, _):
            handleEngineMessageEnd(tabId: tabId, instanceId: instanceId, inputTokens: inputTokens, contextPercent: contextPercent)

        case .engineHarnessMessage(let tabId, let instanceId, let message, _):
            let key = instanceId != nil ? "\(tabId):\(instanceId!)" : tabId
            var msgs = engineMessages[key] ?? []
            msgs.append(EngineMessage(id: UUID().uuidString, role: "harness", content: message, timestamp: Date().timeIntervalSince1970 * 1000))
            engineMessages[key] = msgs

        case .engineConversationHistory(let tabId, let instanceId, let messages):
            let key = instanceId != nil ? "\(tabId):\(instanceId!)" : tabId
            ionLog.info("engineConversationHistory: key=\(key), messageCount=\(messages.count)")
            engineMessages[key] = messages
            engineConversationLoaded.insert(key)

        case .engineDead(let tabId, let instanceId, let exitCode, let signal, let stderrTail):
            handleEngineDead(tabId: tabId, instanceId: instanceId, exitCode: exitCode, signal: signal, stderrTail: stderrTail)

        case .engineInstanceAdded(let tabId, let instanceId, let label):
            let info = EngineInstanceInfo(id: instanceId, label: label)
            engineInstances[tabId, default: []].append(info)
            activeEngineInstance[tabId] = instanceId

        case .engineInstanceRemoved(let tabId, let instanceId):
            handleEngineInstanceRemoved(tabId: tabId, instanceId: instanceId)

        case .engineModelOverride(let tabId, let instanceId, let model):
            let key = instanceId != nil ? "\(tabId):\(instanceId!)" : tabId
            engineModelOverrides[key] = model.isEmpty ? nil : model

        case .engineProfiles(let profiles):
            engineProfiles = profiles
        }
    }

    // MARK: - Connection events

    @MainActor
    private func handleUnpair() {
        // Desktop revoked our pairing -- clear everything and return to discovery.
        // Clear pairedDevices BEFORE disconnect so SwiftUI doesn't briefly show
        // the disconnected view (which auto-triggers reconnect while devices exist).
        pairedDevices = []
        try? KeychainStore.deleteAll()
        pairingState = .idle
        disconnect()
    }

    @MainActor
    private func handleRelayConfig(relayUrl: String, relayApiKey: String) {
        // Desktop pushed updated relay config -- persist it for roaming.
        self.relayURL = relayUrl
        self.relayAPIKey = relayApiKey
        if !pairedDevices.isEmpty {
            pairedDevices[0].relayURL = relayUrl
            pairedDevices[0].relayAPIKey = relayApiKey
            savePairedDevices()
        }
    }

    @MainActor
    private func handleSnapshot(snapshotTabs: [RemoteTabState], recentDirs: [String], groupMode: String?, groups: [RemoteTabGroup]?) {
        if connectionState != .connected {
            connectionState = .connected
        }
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
                let localOnly = existing.permissionQueue.filter { !snapshotIds.contains($0.questionId) }
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
        // Populate terminal state from snapshot tab data
        for tab in merged {
            if tab.isTerminalOnly == true, let instances = tab.terminalInstances {
                terminalInstances[tab.id] = instances
                activeTerminalInstance[tab.id] = tab.activeTerminalInstanceId ?? instances.first?.id
            }
            // Populate engine instance state from snapshot tab data
            if tab.isEngine == true, let instances = tab.engineInstances {
                engineInstances[tab.id] = instances.map { EngineInstanceInfo(id: $0.id, label: $0.label) }
                activeEngineInstance[tab.id] = tab.activeEngineInstanceId ?? instances.first?.id
                ionLog.info("snapshot: engine tab \(tab.id.prefix(8)), instances=\(instances.map(\.id)), active=\(tab.activeEngineInstanceId ?? "nil")")
                // Pre-load engine conversation history for all engine tabs
                loadEngineConversation(tabId: tab.id)
            }
        }
    }

    // MARK: - Tab events

    @MainActor
    private func handleTabClosed(tabId: String) {
        pendingCloseTabIds.remove(tabId)
        tabs.removeAll { $0.id == tabId }
        tabIds.remove(tabId)
        liveText.removeValue(forKey: tabId)
        // Clean up all engine state for this tab
        engineInstances.removeValue(forKey: tabId)
        activeEngineInstance.removeValue(forKey: tabId)
        for key in engineAgentStates.keys where key == tabId || key.hasPrefix("\(tabId):") {
            engineAgentStates.removeValue(forKey: key)
        }
        for key in engineStatusFields.keys where key == tabId || key.hasPrefix("\(tabId):") {
            engineStatusFields.removeValue(forKey: key)
        }
        for key in engineWorkingMessages.keys where key == tabId || key.hasPrefix("\(tabId):") {
            engineWorkingMessages.removeValue(forKey: key)
        }
        for key in engineDialogs.keys where key == tabId || key.hasPrefix("\(tabId):") {
            engineDialogs.removeValue(forKey: key)
        }
        for key in enginePinnedPrompt.keys where key == tabId || key.hasPrefix("\(tabId):") {
            enginePinnedPrompt.removeValue(forKey: key)
        }
        for key in engineMessages.keys where key == tabId || key.hasPrefix("\(tabId):") {
            engineMessages.removeValue(forKey: key)
        }
        for key in activeTools.keys where key == tabId || key.hasPrefix("\(tabId):") {
            activeTools.removeValue(forKey: key)
        }
        engineConversationLoaded = engineConversationLoaded.filter { $0 != tabId && !$0.hasPrefix("\(tabId):") }
    }

    @MainActor
    private func handleTabStatus(tabId: String, status: TabStatus) {
        if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            tabs[idx].status = status
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
    }

    @MainActor
    private func handleTaskComplete(tabId: String) {
        if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            tabs[idx].status = .completed
            // Preserve ExitPlanMode/AskUserQuestion entries for plan card UI
            tabs[idx].permissionQueue.removeAll {
                $0.toolName != "ExitPlanMode" && $0.toolName != "AskUserQuestion"
            }
            // Capture final preview from accumulated live text before it's cleared
            if let text = liveText[tabId], !text.isEmpty {
                tabs[idx].lastMessage = String(text.suffix(64))
                    .replacingOccurrences(of: "\n", with: " ")
            }
        }
        liveText.removeValue(forKey: tabId)
        activeTools.removeValue(forKey: tabId)
        for key in activeTools.keys where key.hasPrefix("\(tabId):") {
            activeTools.removeValue(forKey: key)
        }
    }

    // MARK: - Permission/message events

    @MainActor
    private func handlePermissionRequest(tabId: String, questionId: String, toolName: String, toolInput: [String: AnyCodable]?, options: [PermissionOption]) {
        if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            // Normalize AnyCodable toolInput to Foundation types so the
            // card views can parse with simple `as?` casts. The Codable
            // decoder wraps nested values as [AnyCodable]/[String: AnyCodable],
            // but the card views expect Foundation types (NSArray/NSDictionary)
            // which is what JSONSerialization produces.
            var normalizedInput = toolInput
            if let input = toolInput,
               let data = try? JSONEncoder().encode(input),
               let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                normalizedInput = dict.mapValues { AnyCodable($0) }
            }
            let request = PermissionRequest(
                questionId: questionId,
                toolName: toolName,
                toolInput: normalizedInput,
                options: options
            )
            tabs[idx].permissionQueue.append(request)
        }
    }

    @MainActor
    private func handleConversationHistory(tabId: String, newMessages: [Message], hasMore: Bool, cursor: String?) {
        cancelLoadTimer(tabId: tabId)
        conversationLoadFailed.remove(tabId)
        loadingConversation.remove(tabId)
        conversationLoaded.insert(tabId)
        conversationHasMore[tabId] = hasMore
        conversationCursor[tabId] = cursor
        if cursor != nil {
            suppressScrollToBottom = true
            messages[tabId] = newMessages + (messages[tabId] ?? [])
        } else {
            messages[tabId] = newMessages
        }
        messageCountByTab[tabId] = messages[tabId]?.count ?? 0
    }

    @MainActor
    private func handleMessageAdded(tabId: String, message: Message) {
        // Always update tab preview for user/assistant messages (even if conversation isn't loaded)
        if message.role == .user || message.role == .assistant {
            if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
                tabs[idx].lastMessage = String(message.content.prefix(64))
                    .replacingOccurrences(of: "\n", with: " ")
            }
        }
        guard conversationLoaded.contains(tabId) else { return }
        if messages[tabId] != nil {
            if messages[tabId]!.contains(where: { $0.id == message.id }) { return }
            messages[tabId]!.append(message)
        } else {
            messages[tabId] = [message]
        }
        messageCountByTab[tabId] = messages[tabId]?.count ?? 0
    }

    @MainActor
    private func handleMessageUpdated(tabId: String, messageId: String, content: String?, toolStatus: ToolStatus?, toolInput: String?) {
        guard conversationLoaded.contains(tabId) else { return }
        if let idx = messages[tabId]?.firstIndex(where: { $0.id == messageId }) {
            if let content {
                messages[tabId]![idx].content = content
            }
            if let toolStatus {
                // Meta-tools report as errors but should show as completed (not error, not stuck running)
                let toolName = messages[tabId]![idx].toolName
                if toolName == "ExitPlanMode" || toolName == "AskUserQuestion" {
                    messages[tabId]![idx].toolStatus = .completed
                } else {
                    messages[tabId]![idx].toolStatus = toolStatus
                }
            }
            if let toolInput {
                messages[tabId]![idx].toolInput = toolInput
            }
        }
    }

    @MainActor
    private func handleInputPrefill(tabId: String, text: String, switchTo: Bool) {
        pendingInputByTab[tabId] = text
        if switchTo {
            pendingNavigationTabId = tabId
        } else {
            // Rewind: reload the conversation for this tab
            conversationLoaded.remove(tabId)
            messages.removeValue(forKey: tabId)
            messageCountByTab.removeValue(forKey: tabId)
            conversationLoadFailed.remove(tabId)
            loadConversation(tabId: tabId)
        }
    }

}

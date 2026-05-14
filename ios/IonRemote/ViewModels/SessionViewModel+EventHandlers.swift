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

            // Stream ended naturally -- flush remaining events.
            // Don't wipe state here: softReconnect keeps state alive.
            // Only wipe if cancelled explicitly via disconnect().
            guard !Task.isCancelled else { return }
            let remaining = await self.eventBatcher.drain()
            if !remaining.isEmpty {
                await MainActor.run {
                    for event in remaining { self.handleEvent(event) }
                }
            }
        }

        // Flusher: drain batched events every ~16ms and process on MainActor
        flushTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(16))
                guard !Task.isCancelled, let self else { break }
                let batch = await self.eventBatcher.drain()
                // Sync connectionQuality.transportState so signal bars update promptly.
                let latestTransport = self.transport?.state ?? .disconnected
                let needsStateSync = self.connectionQuality.transportState != latestTransport
                guard !batch.isEmpty || needsStateSync else { continue }
                await MainActor.run {
                    for event in batch {
                        self.handleEvent(event)
                    }
                    if needsStateSync {
                        self.connectionQuality.transportState = latestTransport
                    }
                }
            }
        }
    }

    @MainActor
    func handleEvent(_ event: RemoteEvent) {
        if case .heartbeat = event { /* skip noisy log */ } else {
            print("[Ion] handleEvent: \(event)")
        }
        switch event {
        case .unpair:
            handleUnpair()

        case .relayConfig(let relayUrl, let relayApiKey):
            handleRelayConfig(relayUrl: relayUrl, relayApiKey: relayApiKey)

        case .transportReconnecting:
            DiagnosticLog.log("EVENT: transportReconnecting was=\(connectionState)")
            if connectionState == .connected {
                connectionState = .reconnecting
            }
            connectionQuality.transportState = transport?.state ?? .disconnected

        case .heartbeat(let senderTs, let buffered):
            connectionQuality.transportState = transport?.state ?? .disconnected
            connectionQuality.recordHeartbeat(senderTs: senderTs, buffered: buffered)

        case .peerDisconnected:
            DiagnosticLog.log("EVENT: peerDisconnected was=\(connectionState)")
            // Don't tear down the transport — the relay auto-reconnects and
            // startRelayStateObservation re-sends sync when the peer returns.
            if connectionState == .connected || connectionState == .connecting {
                connectionState = .reconnecting
                startReconnectSafetyTimer()
            }
            connectionQuality.transportState = transport?.state ?? .disconnected

        case .snapshot(let snapshotTabs, let recentDirs, let snapshotGroupMode, let snapshotGroups, let snapshotPreferredModel, let snapshotEngineDefaultModel):
            handleSnapshot(snapshotTabs: snapshotTabs, recentDirs: recentDirs, groupMode: snapshotGroupMode, groups: snapshotGroups, preferredModel: snapshotPreferredModel, engineDefaultModel: snapshotEngineDefaultModel)

        case .tabCreated(let tab):
            if !tabs.contains(where: { $0.id == tab.id }) {
                tabs.append(tab)
                tabIds.insert(tab.id)
            }
            if awaitingLocalTabCreation {
                pendingNavigationTabId = tab.id
                awaitingLocalTabCreation = false
            }

        case .tabClosed(let tabId):
            handleTabClosed(tabId: tabId)

        case .tabStatus(let tabId, let status):
            handleTabStatus(tabId: tabId, status: status)

        case .textChunk(let tabId, let text):
            // Update tab preview for the tab list (shows most recent text)
            if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
                let preview = (liveText[tabId] ?? "") + text
                tabs[idx].lastMessage = String(preview.suffix(64))
                    .replacingOccurrences(of: "\n", with: " ")
            }
            guard !conversationLoaded.contains(tabId) else { break }
            liveText[tabId, default: ""] += text

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
            let filtered = messages.filter { $0.isInternal != true }
            ionLog.info("engineConversationHistory: key=\(key), messageCount=\(messages.count), filtered=\(filtered.count)")
            engineMessages[key] = filtered
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

        // Git events
        case .gitChangesResponse(let directory, let response):
            gitChanges[directory] = response

        case .gitGraphResponse(let directory, let response):
            gitGraph[directory] = response

        case .gitDiffResponse(let response):
            gitDiffResult = response
            gitDiffLoading = false

        // File explorer events
        case .fsDirListing(let directory, let response):
            fileListings[directory] = response
            fileListingLoading.remove(directory)

        case .fsFileContent(let filePath, let response):
            fileContent[filePath] = response
            fileContentLoading.remove(filePath)

        case .fsWriteResult(_, let response):
            fileWriteResult = response

        case .uploadAttachmentResult(let id, let name, let path, let correlationId, let error):
            handleUploadAttachmentResult(id: id, name: name, path: path, correlationId: correlationId, error: error)

        // Command discovery events
        case .discoverCommandsResponse(let directory, let commands):
            discoveredCommands[directory] = commands
        }
    }

    // MARK: - Connection events

    @MainActor
    private func handleUnpair() {
        // Desktop revoked our pairing -- remove only the active device.
        if let device = activeDevice {
            pairedDevices.removeAll { $0.id == device.id }
            LayoutCache.delete(deviceId: device.id)
        }
        savePairedDevices()
        if pairedDevices.isEmpty {
            try? KeychainStore.deleteAll()
            activeDeviceId = nil
            pairingState = .idle
            disconnect()
        } else {
            // Switch to the next available device.
            let nextId = pairedDevices.first!.id
            switchToDevice(id: nextId)
        }
    }

    @MainActor
    private func handleRelayConfig(relayUrl: String, relayApiKey: String) {
        // Desktop pushed updated relay config -- persist it for roaming.
        // Guard: if the active device is a LAN-only pairing (apiKey "lan-direct")
        // and the incoming config doesn't provide BOTH a relay URL and API key,
        // keep the LAN-direct sentinel intact. Without this, a desktop with no
        // relay would overwrite the "lan-direct" marker, breaking reconnects.
        // A legitimate relay upgrade must provide both values.
        if let device = activeDevice, device.relayAPIKey == "lan-direct" {
            guard !relayUrl.isEmpty, !relayApiKey.isEmpty else {
                DiagnosticLog.log("RELAY-CFG: rejected empty for lan-direct \(device.name)")
                print("[Ion] handleRelayConfig: ignoring incomplete relay config for LAN-direct device \(device.name)")
                return
            }
            // Legitimate upgrade from LAN-direct to relay — fall through.
        }

        self.relayURL = relayUrl
        self.relayAPIKey = relayApiKey
        if let device = activeDevice,
           let idx = pairedDevices.firstIndex(where: { $0.id == device.id }) {
            pairedDevices[idx].relayURL = relayUrl
            pairedDevices[idx].relayAPIKey = relayApiKey
            savePairedDevices()
            DiagnosticLog.log("RELAY-CFG: accepted for \(device.id.prefix(8))")
        }
    }

    // MARK: - Tab events

    @MainActor
    private func handleTabClosed(tabId: String) {
        pendingCloseTabIds.remove(tabId)
        tabIdleSince.removeValue(forKey: tabId)
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
        tabIdleSince[tabId] = Date()

        // Speak the final assistant response via TTS (if voice is enabled)
        let key = engineCompoundKey(tabId: tabId)
        if let lastAssistant = engineMessages[key]?.last(where: { $0.role == "assistant" }),
           !lastAssistant.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
           lastAssistant.content.count > 20 {
            voiceService.speak(text: lastAssistant.content)
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
        liveText.removeValue(forKey: tabId)
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
            // Replace optimistic local insert: if the last message is a user message
            // we inserted locally (source == .remote) with the same content, replace
            // it with the canonical message from the desktop.
            if message.role == .user,
               let lastIdx = messages[tabId]!.indices.last,
               messages[tabId]![lastIdx].role == .user,
               messages[tabId]![lastIdx].source == .remote,
               messages[tabId]![lastIdx].content == message.content {
                messages[tabId]![lastIdx] = message
            } else {
                messages[tabId]!.append(message)
            }
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

    // MARK: - Upload attachment result

    @MainActor
    private func handleUploadAttachmentResult(id: String, name: String, path: String, correlationId: String?, error: String?) {
        if let error, !error.isEmpty {
            pendingUploadResults.append(UploadAttachmentResult(id: "", name: name, path: "", correlationId: correlationId, error: error))
        } else {
            pendingUploadResults.append(UploadAttachmentResult(id: id, name: name, path: path, correlationId: correlationId, error: nil))
        }
    }

}

import Foundation
import UIKit
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
        DiagnosticLog.logEvent(event)
        switch event {
        case .unpair:
            handleUnpair()

        case .relayConfig(let relayUrl, let relayApiKey):
            handleRelayConfig(relayUrl: relayUrl, relayApiKey: relayApiKey)

        case .transportReconnecting:
            if connectionState == .connected {
                connectionState = .reconnecting
            }
            connectionQuality.transportState = transport?.state ?? .disconnected

        case .heartbeat(let senderTs, let buffered):
            connectionQuality.transportState = transport?.state ?? .disconnected
            connectionQuality.recordHeartbeat(senderTs: senderTs, buffered: buffered)

        case .peerDisconnected:
            // Don't tear down the transport — the relay auto-reconnects and
            // startRelayStateObservation re-sends sync when the peer returns.
            if connectionState == .connected || connectionState == .connecting {
                connectionState = .reconnecting
                startReconnectSafetyTimer()
            }
            connectionQuality.transportState = transport?.state ?? .disconnected

        case .snapshot(let snapshotTabs, let recentDirs, let snapshotGroupMode, let snapshotGroups, let snapshotPreferredModel, let snapshotEngineDefaultModel, let snapshotAvailableModels, let snapshotCustomName, let snapshotCustomIcon, let snapshotRemoteDisplayUpdatedAt):
            handleSnapshot(snapshotTabs: snapshotTabs, recentDirs: recentDirs, groupMode: snapshotGroupMode, groups: snapshotGroups, preferredModel: snapshotPreferredModel, engineDefaultModel: snapshotEngineDefaultModel, availableModels: snapshotAvailableModels)
            applySnapshotRemoteDisplay(customName: snapshotCustomName, customIcon: snapshotCustomIcon, updatedAt: snapshotRemoteDisplayUpdatedAt)

        case .remoteDisplay(let customName, let customIcon, let updatedAt):
            applyLiveRemoteDisplay(customName: customName, customIcon: customIcon, updatedAt: updatedAt)

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
            // Engine contract: `engine_agent_state` is a complete snapshot
            // of every agent the engine considers live. Replace local
            // state with the payload, full stop — no merging, no historical
            // preservation. See docs/architecture/agent-state.md.
            //
            // Compound-key resolution: when the engine omits instanceId we
            // resolve to the active engine instance so the event lands
            // under the same key the EngineView reads. The desktop bridge
            // always sends an instanceId today, but this guards against a
            // future emitter (or test harness) that sends nil and matches
            // how engineCompoundKey(tabId:) builds keys for view lookup.
            let key = resolveEngineKey(tabId: tabId, instanceId: instanceId)
            let statuses = agents.map { "\($0.name):\($0.status)" }.joined(separator: ",")
            DiagnosticLog.log("ENGINE: agent_state key=\(key) count=\(agents.count) statuses=[\(statuses)]")
            engineAgentStates[key] = agents

        case .engineStatus(let tabId, let instanceId, let fields, _):
            let key = resolveEngineKey(tabId: tabId, instanceId: instanceId)
            engineStatusFields[key] = fields

        case .engineWorkingMessage(let tabId, let instanceId, let message, _):
            let key = resolveEngineKey(tabId: tabId, instanceId: instanceId)
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

        case .engineNotify(let tabId, let instanceId, let message, let level, _):
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

        case .engineHarnessMessage(let tabId, let instanceId, let message, _, _):
            let key = instanceId != nil ? "\(tabId):\(instanceId!)" : tabId
            var msgs = engineMessages[key] ?? []
            msgs.append(Message(id: UUID().uuidString, role: .harness, content: message, timestamp: Date().timeIntervalSince1970 * 1000))
            engineMessages[key] = msgs

        case .engineConversationHistory(let tabId, let instanceId, let messages):
            let key = instanceId != nil ? "\(tabId):\(instanceId!)" : tabId
            let filtered = messages.filter { $0.isInternal != true }
            ionLog.info("engineConversationHistory: key=\(key), messageCount=\(messages.count), filtered=\(filtered.count)")
            engineMessages[key] = filtered
            engineConversationLoaded.insert(key)

        case .agentConversationHistory(let agentName, let conversationId, let messages):
            handleAgentConversationHistory(agentName: agentName, conversationId: conversationId, messages: messages)

        case .engineDead(let tabId, let instanceId, let exitCode, let signal, let stderrTail):
            handleEngineDead(tabId: tabId, instanceId: instanceId, exitCode: exitCode, signal: signal, stderrTail: stderrTail)

        case .engineInstanceAdded(let tabId, let instanceId, let label):
            let info = EngineInstanceInfo(id: instanceId, label: label)
            engineInstances[tabId, default: []].append(info)
            activeEngineInstance[tabId] = instanceId

        case .engineInstanceRemoved(let tabId, let instanceId):
            handleEngineInstanceRemoved(tabId: tabId, instanceId: instanceId)

        case .engineInstanceMoved(let sourceTabId, let instanceId, let targetTabId):
            // Server-confirmed move: reconcile local state.
            // Mirrors desktop's engine-slice.ts:200-230 which rekeys every
            // compound-keyed Map when an instance moves between tabs.
            // Without this, agent state, status, working message, dialogs,
            // and tool state are orphaned under the old compound key and
            // silently disappear from the view when the user switches to
            // the target tab.
            if var srcInstances = engineInstances[sourceTabId],
               let idx = srcInstances.firstIndex(where: { $0.id == instanceId }) {
                let inst = srcInstances.remove(at: idx)
                engineInstances[sourceTabId] = srcInstances.isEmpty ? nil : srcInstances
                if srcInstances.isEmpty {
                    activeEngineInstance.removeValue(forKey: sourceTabId)
                } else if activeEngineInstance[sourceTabId] == instanceId {
                    activeEngineInstance[sourceTabId] = srcInstances.last?.id
                }
                var tgtInstances = engineInstances[targetTabId] ?? []
                if !tgtInstances.contains(where: { $0.id == instanceId }) {
                    tgtInstances.append(inst)
                    engineInstances[targetTabId] = tgtInstances
                }
                activeEngineInstance[targetTabId] = instanceId

                // Rekey every compound-keyed map so the agent panel,
                // status bar, working banner, and active tools follow
                // the instance to its new tab.
                let oldKey = "\(sourceTabId):\(instanceId)"
                let newKey = "\(targetTabId):\(instanceId)"
                rekeyEngineMaps(oldKey: oldKey, newKey: newKey)
            } else {
                DiagnosticLog.log("ENGINE: instance_moved: src not found sourceTabId=\(sourceTabId.prefix(8)) instanceId=\(instanceId.prefix(8))")
            }

        case .engineModelOverride(let tabId, let instanceId, let model):
            let key = instanceId != nil ? "\(tabId):\(instanceId!)" : tabId
            engineModelOverrides[key] = model.isEmpty ? nil : model

        case .engineProfiles(let profiles):
            engineProfiles = profiles

        case .enginePlanProposal:
            handleEnginePlanProposal()

        case .engineEarlyStopDecisionRequest:
            handleEngineEarlyStopDecisionRequest()

        case .engineCommandRegistry(let tabId, let instanceId, let commands):
            handleEngineCommandRegistry(tabId: tabId, instanceId: instanceId, commands: commands)

        case .engineCommandResult:
            handleEngineCommandResult()

        case .desktopSettingsSnapshot(let settings, let schema, let groups):
            // Per-desktop user-preferences projection. Snapshot semantics
            // — replace the cached state wholesale. The view layer binds
            // to `viewModel.desktopSettings` and re-renders the Settings
            // detail screen automatically when this assignment fires.
            //
            // Per-desktop scoping: this snapshot describes the currently-
            // connected desktop only. Switching to a different paired
            // desktop (via `switchToDevice`) clears the cache and the
            // new desktop's initial snapshot will repopulate it.
            desktopSettings = DesktopSettingsState(
                settings: settings,
                schema: schema,
                groups: groups,
            )

        // Git events
        case .gitChangesResponse(let directory, let response):
            gitChanges[directory] = response

        case .gitGraphResponse(let directory, let response):
            gitGraph[directory] = response

        case .gitDiffResponse(let response):
            gitDiffResult = response
            gitDiffLoading = false

        case .gitCommitResult(let result):
            if result.ok {
                Haptic.success()
                gitToast = GitToast(message: "Committed successfully", isError: false)
            } else {
                Haptic.error()
                gitToast = GitToast(message: result.error ?? "Commit failed", isError: true)
            }

        case .gitStageResult(let result):
            if result.ok {
                Haptic.success()
            } else {
                Haptic.error()
                gitToast = GitToast(message: result.error ?? "Stage failed", isError: true)
            }

        case .gitUnstageResult(let result):
            if result.ok {
                Haptic.success()
            } else {
                Haptic.error()
                gitToast = GitToast(message: result.error ?? "Unstage failed", isError: true)
            }

        case .gitCommitFilesResponse(let response):
            gitCommitFiles[response.hash] = response

        case .gitCommitFileDiffResponse(let response):
            let key = "\(response.hash):\(response.path)"
            gitCommitFileDiff[key] = response

        // File explorer events
        case .fsDirListing(let directory, let response):
            fileListings[directory] = response
            fileListingLoading.remove(directory)

        case .fsFileContent(let filePath, let response):
            fileContent[filePath] = response
            fileContentLoading.remove(filePath)

        case .fsImageContent(let filePath, let dataUrl, _):
            RemoteImageFetcher.shared.deliver(path: filePath, dataUrl: dataUrl)

        case .fsWriteResult(_, let response):
            fileWriteResult = response

        case .fsRenameResult(_, let newPath, let response):
            // Lightweight pattern mirroring `.fsWriteResult`:
            //   - publish the response so the view can surface errors,
            //   - on success, re-issue `fsListDir` on the parent dir of
            //     newPath so the listing reflects the rename. We don't
            //     also refresh oldPath's parent because the desktop
            //     handler only ever changes basename, so the parents
            //     match. If a future variant ever moves across
            //     directories, this is the spot to add the second
            //     refresh.
            fileRenameResult = response
            if response.ok {
                let parent = (newPath as NSString).deletingLastPathComponent
                if !parent.isEmpty {
                    requestFsListDir(directory: parent)
                }
            }

        case .uploadAttachmentResult(let id, let name, let path, let correlationId, let error):
            handleUploadAttachmentResult(id: id, name: name, path: path, correlationId: correlationId, error: error)

        case .tabAttachments(let tabId, let attachments):
            tabAttachmentCache[tabId] = attachments

        // Command discovery events
        case .discoverCommandsResponse(let directory, let commands):
            discoveredCommands[directory] = commands

        // Diagnostic log request from desktop
        case .requestDiagnosticLogs:
            handleRequestDiagnosticLogs()
        }
    }

    // MARK: - Connection events
    //
    // `handleUnpair` and `handleRelayConfig` live in
    // SessionViewModel+ConnectionEvents.swift to keep this file under the
    // 600-line cap. The dispatch above just calls them.

    // MARK: - Permission/message events

    @MainActor
    private func handlePermissionRequest(tabId: String, questionId: String, toolName: String, toolInput: [String: AnyCodable]?, options: [PermissionOption]) {
        let inputKeys = toolInput?.keys.sorted() ?? []
        let inputSummary = toolInput?.map { "\($0.key): \(type(of: $0.value.value))" }.joined(separator: ", ") ?? "nil"
        let isEngine = tabs.first(where: { $0.id == tabId })?.isEngine == true
        DiagnosticLog.log("PERM: handlePermissionRequest: tabId=\(tabId.prefix(8)) questionId=\(questionId.prefix(16)) toolName=\(toolName) inputKeys=\(inputKeys) inputTypes=[\(inputSummary)] options=\(options.map(\.label)) isEngine=\(isEngine)")

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
                let normalizedSummary = normalizedInput?.map { "\($0.key): \(type(of: $0.value.value))" }.joined(separator: ", ") ?? "nil"
                DiagnosticLog.log("PERM: handlePermissionRequest: normalized toolInput types=[\(normalizedSummary)]")
            } else {
                DiagnosticLog.log("PERM: handlePermissionRequest: normalization failed or skipped, using raw toolInput")
            }
            let request = PermissionRequest(
                questionId: questionId,
                toolName: toolName,
                toolInput: normalizedInput,
                options: options
            )
            DiagnosticLog.log("PERM: handlePermissionRequest: queued request for tabId=\(tabId.prefix(8)) queueSize=\(self.tabs[idx].permissionQueue.count + 1)")
            tabs[idx].permissionQueue.append(request)
        } else {
            DiagnosticLog.log("PERM: handlePermissionRequest: tab \(tabId.prefix(8)) not found, dropping permission request")
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

        // Deduplicate by message ID, keeping last occurrence (most recent version).
        let deduped = deduplicateMessages(newMessages)

        if cursor != nil {
            suppressScrollToBottom = true
            messages[tabId] = deduped + (messages[tabId] ?? [])
        } else {
            messages[tabId] = deduped
        }
        messageCountByTab[tabId] = messages[tabId]?.count ?? 0

        // Log the last 3 messages for diagnostics (permission card restoration depends on message content).
        let allMsgs = messages[tabId] ?? []
        let tail = allMsgs.suffix(3)
        let tailSummary = tail.map { "role=\($0.role.rawValue) toolName=\($0.toolName ?? "nil") isTool=\($0.isTool) toolInput=\($0.toolInput?.prefix(60) ?? "nil")" }.joined(separator: " | ")
        DiagnosticLog.log("CONV-HIST: tabId=\(tabId.prefix(8)) total=\(allMsgs.count) hasMore=\(hasMore) cursor=\(cursor?.prefix(8) ?? "nil") tail=[\(tailSummary)]")
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
        if var existing = messages[tabId] {
            // ID-based reconciliation: if a message with this ID already exists
            // (optimistic insert), replace it with the canonical version from desktop.
            if let existingIdx = existing.firstIndex(where: { $0.id == message.id }) {
                existing[existingIdx] = message
            } else {
                existing.append(message)
            }
            messages[tabId] = existing
        } else {
            messages[tabId] = [message]
        }
        messageCountByTab[tabId] = messages[tabId]?.count ?? 0
    }

    @MainActor
    private func handleMessageUpdated(tabId: String, messageId: String, content: String?, toolStatus: ToolStatus?, toolInput: String?) {
        guard conversationLoaded.contains(tabId),
              var msgs = messages[tabId],
              let idx = msgs.firstIndex(where: { $0.id == messageId })
        else { return }

        if let content {
            msgs[idx].content = content
        }
        if let toolStatus {
            // Meta-tools report as errors but should show as completed (not error, not stuck running)
            let toolName = msgs[idx].toolName
            if toolName == "ExitPlanMode" || toolName == "AskUserQuestion" {
                msgs[idx].toolStatus = .completed
            } else {
                msgs[idx].toolStatus = toolStatus
            }
        }
        if let toolInput {
            msgs[idx].toolInput = toolInput
        }
        messages[tabId] = msgs
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

    /// Deduplicate messages by ID, keeping the last occurrence of each.
    private func deduplicateMessages(_ msgs: [Message]) -> [Message] {
        var seen = Set<String>()
        var result: [Message] = []
        for msg in msgs.reversed() {
            if seen.insert(msg.id).inserted {
                result.append(msg)
            }
        }
        result.reverse()
        return result
    }

    @MainActor
    private func handleUploadAttachmentResult(id: String, name: String, path: String, correlationId: String?, error: String?) {
        if let error, !error.isEmpty {
            pendingUploadResults.append(UploadAttachmentResult(id: "", name: name, path: "", correlationId: correlationId, error: error))
        } else {
            pendingUploadResults.append(UploadAttachmentResult(id: id, name: name, path: path, correlationId: correlationId, error: nil))
        }
    }

}

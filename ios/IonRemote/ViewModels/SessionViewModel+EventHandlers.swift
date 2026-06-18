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

        case .snapshot(let snapshotTabs, let recentDirs, let snapshotGroupMode, let snapshotGroups, let snapshotPreferredModel, let snapshotEngineDefaultModel, let snapshotAvailableModels, let snapshotCustomName, let snapshotCustomIcon, let snapshotRemoteDisplayUpdatedAt, let snapshotResources):
            handleSnapshot(snapshotTabs: snapshotTabs, recentDirs: recentDirs, groupMode: snapshotGroupMode, groups: snapshotGroups, preferredModel: snapshotPreferredModel, engineDefaultModel: snapshotEngineDefaultModel, availableModels: snapshotAvailableModels)
            applySnapshotRemoteDisplay(customName: snapshotCustomName, customIcon: snapshotCustomIcon, updatedAt: snapshotRemoteDisplayUpdatedAt)
            if let snapshotResources {
                for (kind, rawItems) in snapshotResources {
                    resourceStore.applySnapshot(kind: kind, rawItems: rawItems)
                }
            }

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

        case .permissionRequest(let tabId, let instanceId, let questionId, let toolName, let toolInput, let options):
            handlePermissionRequest(tabId: tabId, instanceId: instanceId, questionId: questionId, toolName: toolName, toolInput: toolInput, options: options)

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

        case .inputPrefill(let tabId, let text, let switchTo, let instanceId):
            handleInputPrefill(tabId: tabId, text: text, switchTo: switchTo, instanceId: instanceId)

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
            // Instance resolution: when the engine omits instanceId we
            // resolve to the active engine instance so the event lands
            // on the same instance the EngineView reads. The desktop bridge
            // always sends an instanceId today, but this guards against a
            // future emitter (or test harness) that sends nil.
            let resolvedId = resolveInstanceId(tabId: tabId, instanceId: instanceId)
            let statuses = agents.map { "\($0.name):\($0.status)" }.joined(separator: ",")
            DiagnosticLog.log("ENGINE: agent_state tabId=\(tabId.prefix(8)) instId=\(resolvedId?.prefix(8) ?? "nil") count=\(agents.count) statuses=[\(statuses)]")
            mutateEngineInstance(tabId: tabId, instanceId: resolvedId) { $0.agentStates = agents }

        case .engineStatus(let tabId, let instanceId, let fields, _):
            let resolvedId = resolveInstanceId(tabId: tabId, instanceId: instanceId)
            mutateEngineInstance(tabId: tabId, instanceId: resolvedId) { $0.statusFields = fields }

        case .engineSessionStatus(let tabId, let instanceId, let sessionStatus, _):
            // Phase 3 of the state-management overhaul. The typed
            // engine_session_status arrives alongside engine_status;
            // the dispatcher in SessionViewModel+SessionStatus.swift
            // applies it via the same path so readers see consistent
            // state. Phase 4 makes this the sole writer.
            let resolvedId = resolveInstanceId(tabId: tabId, instanceId: instanceId)
            applyEngineSessionStatus(tabId: tabId, instanceId: resolvedId, status: sessionStatus)

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

        case .engineRunStalled(let tabId, let instanceId, let stalledDuration, let lastActivity):
            handleEngineRunStalled(tabId: tabId, instanceId: instanceId, stalledDuration: stalledDuration, lastActivity: lastActivity)

        case .engineSteerInjected(let tabId, let instanceId, let messageLength):
            handleEngineSteerInjected(tabId: tabId, instanceId: instanceId, messageLength: messageLength)

        // Extended-thinking events (issue #158). A thinking block is OPTIONAL
        // per turn; the delta may be gated off for low-bandwidth. The
        // accumulator in SessionViewModel+ThinkingEvents.swift binds
        // block_start → deltas → block_end into a single `.thinking` row.
        case .engineThinkingBlockStart(let tabId, let instanceId):
            handleEngineThinkingBlockStart(tabId: tabId, instanceId: instanceId)

        case .engineThinkingDelta(let tabId, let instanceId, let thinkingText):
            handleEngineThinkingDelta(tabId: tabId, instanceId: instanceId, thinkingText: thinkingText)

        case .engineThinkingBlockEnd(let tabId, let instanceId, let totalTokens, let elapsedSeconds, let redacted):
            handleEngineThinkingBlockEnd(tabId: tabId, instanceId: instanceId, totalTokens: totalTokens, elapsedSeconds: elapsedSeconds, redacted: redacted)

        // No-op: iOS does not render these events yet. Decoding them
        // prevents the 123 decode-errors/session diagnostic finding.
        case .engineToolUpdate, .engineToolComplete, .engineScheduleFired, .engineLlmCall, .engineDispatchStart:
            break

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
            handleEngineHarnessMessage(tabId: tabId, instanceId: instanceId, message: message)

        case .enginePlanModeChanged(let tabId, let instanceId, let planModeEnabled, _, let planSlug):
            handleEnginePlanModeChanged(tabId: tabId, instanceId: instanceId, planModeEnabled: planModeEnabled, planSlug: planSlug)

        case .engineConversationHistory(let tabId, let instanceId, let messages):
            let key = instanceId != nil ? "\(tabId):\(instanceId!)" : tabId
            let filtered = messages.filter { $0.isInternal != true }
            DiagnosticLog.log("LOAD-CONV: engineConversationHistory key=\(key.prefix(16)) total=\(messages.count) filtered=\(filtered.count) alreadyLoaded=\(engineConversationLoaded.contains(key))")
            mutateEngineInstance(tabId: tabId, instanceId: instanceId) { $0.messages = filtered }
            engineConversationLoaded.insert(key)
            // History reload replaces the message array wholesale — any
            // in-progress thinking block id now points at a message that no
            // longer exists. Clear the accumulator so a late delta/block_end
            // can't mutate the reloaded history. (Stream-reset semantics.)
            clearThinkingAccumulator(forKey: key)

        case .agentConversationHistory(let agentName, let conversationId, let messages):
            handleAgentConversationHistory(agentName: agentName, conversationId: conversationId, messages: messages)

        case .engineDead(let tabId, let instanceId, let exitCode, let signal, let stderrTail):
            handleEngineDead(tabId: tabId, instanceId: instanceId, exitCode: exitCode, signal: signal, stderrTail: stderrTail)

        case .engineInstanceAdded(let tabId, let instanceId, let label):
            let info = ConversationInstanceInfo(id: instanceId, label: label)
            conversationInstances[tabId, default: []].append(info)
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
            if var srcInstances = conversationInstances[sourceTabId],
               let idx = srcInstances.firstIndex(where: { $0.id == instanceId }) {
                let inst = srcInstances.remove(at: idx)
                conversationInstances[sourceTabId] = srcInstances.isEmpty ? nil : srcInstances
                if srcInstances.isEmpty {
                    activeEngineInstance.removeValue(forKey: sourceTabId)
                } else if activeEngineInstance[sourceTabId] == instanceId {
                    activeEngineInstance[sourceTabId] = srcInstances.last?.id
                }
                var tgtInstances = conversationInstances[targetTabId] ?? []
                if !tgtInstances.contains(where: { $0.id == instanceId }) {
                    tgtInstances.append(inst)
                    conversationInstances[targetTabId] = tgtInstances
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
            mutateEngineInstance(tabId: tabId, instanceId: instanceId) {
                $0.modelOverride = model.isEmpty ? nil : model
            }

        case .engineProfiles(let profiles):
            engineProfiles = profiles

        case .enginePlanProposal:
            handleEnginePlanProposal()

        case .enginePlanModeAutoExit:
            handleEnginePlanModeAutoExit()

        case .engineEarlyStopDecisionRequest:
            handleEngineEarlyStopDecisionRequest()

        case .engineCommandRegistry(let tabId, let instanceId, let commands):
            handleEngineCommandRegistry(tabId: tabId, instanceId: instanceId, commands: commands)

        case .engineCommandResult:
            handleEngineCommandResult()

        case .engineExport(let tabId, _, let message, let exportFormat):
            // Engine has rendered a /export payload. Stash it on the
            // view model so a SwiftUI share-sheet observer can pick it
            // up. Bound to ConversationView via the .sheet/.share
            // mechanism in SessionViewModel's pendingExport state.
            // exportFormat drives the shared file's extension.
            handleEngineExport(tabId: tabId, payload: message, format: exportFormat)

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
            let names = attachments.map { "\($0.type):\($0.name)" }.joined(separator: ", ")
            DiagnosticLog.log("ATTACH: tabAttachments received tabId=\(tabId.prefix(8)) count=\(attachments.count) items=[\(names)]")
            tabAttachmentCache[tabId] = attachments

        // Command discovery events
        case .discoverCommandsResponse(let directory, let commands):
            discoveredCommands[directory] = commands

        // Diagnostic log request from desktop
        case .requestDiagnosticLogs:
            handleRequestDiagnosticLogs()

        // Resource events (D-007)
        case .engineResourceSnapshot(_, _, let kind, _, let rawItems):
            resourceStore.applySnapshot(kind: kind, rawItems: rawItems)
        case .engineResourceDelta(_, _, let kind, _, let rawDelta):
            resourceStore.applyDelta(kind: kind, rawDelta: rawDelta)
        case .engineNotification:
            break
        case .resourceContent(let resourceId, let kind, let content):
            resourceStore.updateContent(kind: kind, resourceId: resourceId, content: content)

        case .planContent(let questionId, let planFilePath, let offset, let content, let totalBytes, let hasMore):
            // Assemble paged plan_content into the full body via planContentStore.
            // If hasMore is true, request the next page immediately.
            planContentStore.applyPage(questionId: questionId, content: content, totalBytes: totalBytes, hasMore: hasMore)
            if hasMore {
                // Derive the next offset from the byte length of content received so far.
                let nextOffset = offset + content.utf8.count
                // Re-resolve planFilePath and tabId from the store for the next request.
                // We don't have tabId here but we track it in planContentStore's state.
                // For the continuation we use the planFilePath from this event + stored tabId.
                requestNextPlanPage(questionId: questionId, planFilePath: planFilePath, nextOffset: nextOffset)
            }

        case .engineIntercept(let tabId, let instanceId, let level, let title, let message, _, _):
            handleEngineIntercept(tabId: tabId, instanceId: instanceId, level: level, title: title, message: message)
        }
    }

    // MARK: - Connection events
    // handleUnpair and handleRelayConfig live in SessionViewModel+ConnectionEvents.swift.

    // MARK: - Permission/message events
    //
    // handlePermissionRequest, handleConversationHistory,
    // handleMessageAdded, handleMessageUpdated, and handleInputPrefill
    // live in SessionViewModel+PermissionMessageEvents.swift to keep
    // this file under the 600-line cap. They are members of the same
    // `extension SessionViewModel` so the dispatch in handleEvent
    // above resolves them without further wiring.

    // MARK: - Upload attachment result

    // `deduplicateMessages` lives in SessionViewModel+ConversationHelpers.swift
    // to keep this file under the 600-line cap.

    // `handleUploadAttachmentResult` lives in
    // SessionViewModel+UploadEvents.swift to keep this file under the
    // 600-line cap. The dispatch above just calls it.

}

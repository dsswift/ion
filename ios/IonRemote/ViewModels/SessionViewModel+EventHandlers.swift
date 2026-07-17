import Foundation
import UIKit
import os

private let ionLog = Logger(subsystem: "com.sprague.ion.mobile", category: "engine")

// MARK: - Event dispatch
//
// `startListening()` (the transport→batcher collector + flush loop) lives in
// SessionViewModel+Listening.swift to keep this file under the 600-line cap.

extension SessionViewModel {

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

        case .resendUnavailable:
            // Gap-recovery control event. The TransportManager already cleared
            // its pending-resend range on receipt; nothing more to do at the
            // ViewModel layer — the snapshot reconcile heals the gap. Observed
            // here only to keep the event switch exhaustive.
            break

        case .peerDisconnected:
            // Don't tear down the transport — the relay auto-reconnects and
            // startRelayStateObservation re-sends sync when the peer returns.
            if connectionState == .connected || connectionState == .connecting {
                connectionState = .reconnecting
                startReconnectSafetyTimer()
            }
            connectionQuality.transportState = transport?.state ?? .disconnected

        case .lanAuthRejected:
            handleLANAuthRejected()

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

        case .tabCreated(let tab, let clientCmdId):
            if !tabs.contains(where: { $0.id == tab.id }) {
                tabs.append(tab)
                tabIds.insert(tab.id)
            }
            // Clear the confirm-or-resend tracker for this create. A match means
            // the creation was locally initiated, so navigate to it (replacing
            // the former `awaitingLocalTabCreation` flag). A resent create the
            // desktop deduped still echoes the same id, so navigation and the
            // tracker-clear fire exactly once.
            if confirmCreate(clientCmdId: clientCmdId) {
                pendingNavigationTabId = tab.id
            }

        case .tabClosed(let tabId):
            handleTabClosed(tabId: tabId)

        case .tabStatus(let tabId, let status):
            handleTabStatus(tabId: tabId, status: status)

        case .tabMeta(let tabId, let title, let totalCostUsd, let groupId):
            handleTabMeta(tabId: tabId, title: title, totalCostUsd: totalCostUsd, groupId: groupId)

        case .textChunk(let tabId, let text):
            // Update tab preview for the tab list (shows most recent text)
            if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
                let preview = liveText(tabId) + text
                tabs[idx].lastMessage = String(preview.suffix(64))
                    .replacingOccurrences(of: "\n", with: " ")
            }
            guard !conversationLoaded.contains(tabId) else { break }
            appendLiveText(tabId: tabId, text)

        case .toolCall(let tabId, let toolName, _):
            guard !conversationLoaded.contains(tabId) else { break }
            appendLiveText(tabId: tabId, "\n> \(toolName)\n")

        case .toolResult(let tabId, _, let content, let isError):
            guard !conversationLoaded.contains(tabId) else { break }
            let prefix = isError ? "[error]" : "[ok]"
            let truncated = content.prefix(200)
            appendLiveText(tabId: tabId, "\(prefix) \(truncated)\n")

        case .taskComplete(let tabId, _, _):
            handleTaskComplete(tabId: tabId)

        case .permissionRequest(let tabId, let instanceId, let questionId, let toolName, let toolInput, let options):
            handlePermissionRequest(tabId: tabId, instanceId: instanceId, questionId: questionId, toolName: toolName, toolInput: toolInput, options: options)

        case .permissionResolved(let tabId, let questionId):
            if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
                tabs[idx].permissionQueue.removeAll { $0.questionId == questionId }
            }

        case .conversationHistory(let tabId, let newMessages, let hasMore, let cursor, let before):
            handleConversationHistory(tabId: tabId, newMessages: newMessages, hasMore: hasMore, cursor: cursor, before: before)

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
            appendLiveText(tabId: tabId, "\n[error] \(message)\n")

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
            // Post-#256 a tab has exactly one conversation instance, so the
            // event's instanceId is vestigial — mutateEngineInstance targets
            // that single instance regardless.
            let statuses = agents.map { "\($0.name):\($0.status)" }.joined(separator: ",")
            DiagnosticLog.log("agent state", tag: "session.events", level: .debug, fields: [
                "tab_id": String(tabId.prefix(8)),
                "count": String(agents.count),
                "agent": statuses
            ])
            mutateEngineInstance(tabId: tabId, instanceId: instanceId) { $0.agentStates = agents }
            // Clear push/snapshot input caches for terminal dispatches so
            // stale push entries don't produce ghost duplicates on popup reopen.
            clearTerminalDispatchCaches(for: agents)

        case .engineStatus(let tabId, let instanceId, let fields, _):
            mutateEngineInstance(tabId: tabId, instanceId: instanceId) { $0.statusFields = fields }
            // Detect engine restarts: a changed sessionId means a new engine
            // binary is running and all cached dispatch snapshots may be stale.
            handleEngineSessionIdChange(tabId: tabId, sessionId: fields.sessionId)

        case .engineSessionStatus(let tabId, let instanceId, let sessionStatus, _):
            // Phase 3 of the state-management overhaul. The typed
            // engine_session_status arrives alongside engine_status;
            // the dispatcher in SessionViewModel+SessionStatus.swift
            // applies it via the same path so readers see consistent
            // state. Phase 4 makes this the sole writer.
            applyEngineSessionStatus(tabId: tabId, instanceId: instanceId, status: sessionStatus)

        case .engineWorkingMessage(let tabId, let instanceId, let message, _):
            _ = instanceId // vestigial post-#256; working message is per-tab
            setWorkingMessage(tabId: tabId, message)

        case .engineToolStart(let tabId, let instanceId, let toolName, let toolId):
            handleEngineToolStart(tabId: tabId, instanceId: instanceId, toolName: toolName, toolId: toolId)

        case .engineToolEnd(let tabId, let instanceId, let toolId, let result, let isError):
            handleEngineToolEnd(tabId: tabId, instanceId: instanceId, toolId: toolId, result: result, isError: isError)

        case .engineToolStalled(let tabId, let instanceId, let toolId, _, _):
            _ = instanceId // unused post-#256, bare tabId is the key
            activeTools[tabId]?[toolId]?.isStalled = true

        case .engineImageContent(let tabId, let instanceId, let path, let mediaType, let source, let toolId):
            handleEngineImageContent(tabId: tabId, instanceId: instanceId, path: path, mediaType: mediaType, source: source, toolId: toolId)

        case .engineRunStalled(let tabId, let instanceId, let stalledDuration, let lastActivity):
            handleEngineRunStalled(tabId: tabId, instanceId: instanceId, stalledDuration: stalledDuration, lastActivity: lastActivity)

        case .engineSteerInjected(let tabId, let instanceId, let messageLength):
            handleEngineSteerInjected(tabId: tabId, instanceId: instanceId, messageLength: messageLength)

        case .enginePromptInjected(let tabId, let instanceId, let prompt, _, let kind):
            // kind="agent_completion" means this is a machine-to-machine dispatch
            // callback (a child agent's result routed to its parent). iOS must NOT
            // inject these as user messages — they are internal signals, not user turns.
            guard kind != "agent_completion" else { break }
            handleEnginePromptInjected(tabId: tabId, instanceId: instanceId, prompt: prompt)

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
        case .engineToolUpdate, .engineToolComplete, .engineScheduleFired, .engineLlmCall:
            break

        // Dispatch telemetry: accumulate start/end into the per-instance
        // dispatchTelemetry array, mirroring desktop buildDispatchStartEntry /
        // applyDispatchEnd in engine-event-slice-helpers.ts.
        case .engineDispatchStart(let tabId, let instanceId, let agent, let sessionId, let model, let task, let depth, let parentId, let dispatchId):
            DiagnosticLog.log("dispatch start", tag: "session.events", level: .debug, fields: [
                "agent": agent,
                "count": String(depth),
                "reason": String(parentId.prefix(16)),
                "run_id": String(dispatchId.prefix(16))
            ])
            let entry = DispatchTelemetryEntry(
                dispatchAgent: agent,
                dispatchSessionId: sessionId,
                dispatchModel: model,
                dispatchTask: task,
                dispatchDepth: depth,
                dispatchParentId: parentId,
                dispatchId: dispatchId
            )
            mutateEngineInstance(tabId: tabId, instanceId: instanceId) {
                var existing = $0.dispatchTelemetry ?? []
                existing.append(entry)
                $0.dispatchTelemetry = existing
            }
        case .engineDispatchEnd(let tabId, let instanceId, let agent, let depth, let parentId, let exitCode, let elapsed, let dispatchId, let conversationId):
            DiagnosticLog.log("dispatch end", tag: "session.events", level: .debug, fields: [
                "agent": agent,
                "count": String(depth),
                "reason": String(parentId.prefix(16)),
                "status": String(exitCode),
                "duration_ms": String(format: "%.2f", elapsed),
                "run_id": String(dispatchId.prefix(16))
            ])
            mutateEngineInstance(tabId: tabId, instanceId: instanceId) {
                guard var telemetry = $0.dispatchTelemetry else { return }
                if let idx = telemetry.firstIndex(where: { $0.dispatchId == dispatchId }) {
                    telemetry[idx].exitCode = exitCode
                    telemetry[idx].elapsed = elapsed
                    telemetry[idx].conversationId = conversationId
                    $0.dispatchTelemetry = telemetry
                }
            }

        case .engineDispatchActivity(_, _, let agentId, let conversationId, let kind, let seq, let toolName, let toolId, let textDelta, let isError, let ts):
            handleDispatchActivity(dispatchAgentId: agentId, conversationId: conversationId, kind: kind, seq: seq, ts: ts, toolName: toolName, toolId: toolId, textDelta: textDelta, isError: isError)

        case .engineError(let tabId, let instanceId, let message):
            handleEngineError(tabId: tabId, instanceId: instanceId, message: message)

        case .engineNotify(let tabId, let instanceId, let message, let level, _):
            handleEngineNotify(tabId: tabId, instanceId: instanceId, message: message, level: level)

        case .engineDialog(let tabId, let instanceId, let dialogId, let method, let title, let options, let defaultValue):
            _ = instanceId // unused post-#256
            engineDialogs[tabId] = EngineDialogInfo(dialogId: dialogId, method: method, title: title, options: options, defaultValue: defaultValue)

        case .engineDialogResolved(let tabId, let instanceId, _):
            _ = instanceId // unused post-#256
            engineDialogs[tabId] = nil

        case .engineTextDelta(let tabId, let instanceId, let text):
            handleEngineTextDelta(tabId: tabId, instanceId: instanceId, text: text)

        case .engineStreamReset(let tabId, let instanceId):
            handleEngineStreamReset(tabId: tabId, instanceId: instanceId)

        case .engineMessageEnd(let tabId, let instanceId, let inputTokens, _, let contextPercent, _, let entryId, let userEntryId):
            handleEngineMessageEnd(tabId: tabId, instanceId: instanceId, inputTokens: inputTokens, contextPercent: contextPercent, entryId: entryId, userEntryId: userEntryId)

        case .engineUserTurnPersisted(let tabId, let instanceId, let entryId):
            handleEngineUserTurnPersisted(tabId: tabId, instanceId: instanceId, entryId: entryId)

        case .engineHarnessMessage(let tabId, let instanceId, let message, _, _, let dedupKey, let dedupMode):
            handleEngineHarnessMessage(tabId: tabId, instanceId: instanceId, message: message, dedupKey: dedupKey, dedupMode: dedupMode)

        // engineConversationHistory event removed (WI-004 / #259).
        // The unified desktop_conversation_history response maps to
        // conversationHistory, handled above. Any stale event from an old
        // desktop build is simply unrecognized and dropped by the decoder.

        case .enginePlanModeChanged(let tabId, let instanceId, let planModeEnabled, let planFilePath, let planSlug):
            handleEnginePlanModeChanged(tabId: tabId, instanceId: instanceId, planModeEnabled: planModeEnabled, planFilePath: planFilePath, planSlug: planSlug)

        case .enginePlanFileWritten(let tabId, let instanceId, let operation, let planFilePath, let planSlug):
            handleEnginePlanFileWritten(tabId: tabId, instanceId: instanceId, operation: operation, planFilePath: planFilePath, planSlug: planSlug)

        case .agentConversationHistory(let agentName, let conversationId, let messages):
            handleAgentConversationHistory(agentName: agentName, conversationId: conversationId, messages: messages)

        case .engineDead(let tabId, let instanceId, let exitCode, let signal, let stderrTail):
            handleEngineDead(tabId: tabId, instanceId: instanceId, exitCode: exitCode, signal: signal, stderrTail: stderrTail)

        // Instance lifecycle events. The desktop still emits desktop_instance_added
        // from the live engine-prompt auto-instance path (tabs-prompt.ts), so the
        // TypeKey + decoder must stay to avoid throwing on a live event. iOS itself
        // is single-instance post-#256: the snapshot is the authoritative source of
        // instance truth, so these carry no additional state for iOS and are
        // intentionally dropped here.
        case .engineInstanceAdded, .engineInstanceRemoved, .engineInstanceMoved:
            break

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

        case .desktopSettingsSnapshot(let settings, let schema, let groups, let newConversationPolicy):
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
            // Enterprise new-conversation policy. Nil means no enterprise config
            // (or pre-#256 desktop); non-nil + locked=true means the
            // new-conversation flow must skip picker and use mandated values.
            enterpriseNewConversationPolicy = newConversationPolicy
            if let policy = newConversationPolicy {
                DiagnosticLog.log("new conversation policy received", tag: "session.events", fields: [
                    "status": String(policy.locked),
                    "path": String(policy.baseDirectory.prefix(40)),
                    "reason": String(policy.engineProfileId.prefix(8))
                ])
            }

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
            DiagnosticLog.log("tab attachments received", tag: "session.events", fields: [
                "tab_id": String(tabId.prefix(8)),
                "count": String(attachments.count),
                "reason": names
            ])
            tabAttachmentCache[tabId] = attachments

        // Command discovery events
        case .discoverCommandsResponse(let directory, let commands):
            discoveredCommands[directory] = commands

        // Diagnostic log request from desktop
        case .requestDiagnosticLogs(let sinceSeq):
            handleRequestDiagnosticLogs(sinceSeq: sinceSeq)

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

        case .desktopContextBreakdown(let tabId, let instanceId, let payload):
            // Per-category context breakdown from the engine (forwarded by the desktop).
            // Store on the active instance so StatusDrawerView can read it without a
            // separate fetch. Mirrors the desktop's engine-event-slice handler that
            // writes contextBreakdown onto the ConversationInstance.
            DiagnosticLog.log("context breakdown", tag: "session.events", level: .debug, fields: [
                "tab_id": String(tabId.prefix(8)),
                "count": String(payload.categories.count),
                "max": String(payload.totalTokens)
            ])
            mutateEngineInstance(tabId: tabId, instanceId: instanceId) {
                $0.contextBreakdown = payload
            }
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

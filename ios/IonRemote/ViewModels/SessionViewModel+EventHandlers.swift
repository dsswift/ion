import UIKit

extension SessionViewModel {
    @MainActor
    func handleEvent(_ event: RemoteEvent) {
        DiagnosticLog.logEvent(event)
        switch event {
        case .unpair:
            handleUnpair()

        case .transportReconnecting:
            cancelTranscriptCopy()
            if connectionState == .connected {
                connectionState = .reconnecting
                markActiveServerTransientlyDisconnected(source: "transport_reconnecting")
            }
            connectionQuality.transportState = transport?.state ?? .disconnected

        case .heartbeat(let senderTs, let buffered):
            connectionQuality.transportState = transport?.state ?? .disconnected
            connectionQuality.recordHeartbeat(senderTs: senderTs, buffered: buffered)

        case .peerDisconnected:
            cancelTranscriptCopy()
            // Don't tear down the transport — the relay auto-reconnects and
            // startRelayStateObservation re-sends sync when the peer returns.
            if connectionState == .connected || connectionState == .connecting {
                connectionState = .reconnecting
                markActiveServerTransientlyDisconnected(source: "peer_disconnected")
                startReconnectSafetyTimer()
            }
            connectionQuality.transportState = transport?.state ?? .disconnected
            lockDeferredRelayMismatchIfNeeded()

        case .lanAuthRejected:
            handleLANAuthRejected()

        case .settledTabs(let tabs):
            // The complete settled set, on its own channel rather than inside
            // the snapshot. Replaces what is held, exactly as the snapshot's
            // own settledTabs field did.
            settledTabs = tabs

        case .snapshot(let snapshotTabs, let recentDirs, let snapshotAvailableModels, let snapshotCustomName, let snapshotCustomIcon, let snapshotRemoteDisplayUpdatedAt, let snapshotResources, let snapshotProjects, let snapshotWorktreeStates, let snapshotSettledTabs):
            handleSnapshot(snapshotTabs: snapshotTabs, recentDirs: recentDirs, availableModels: snapshotAvailableModels, projects: snapshotProjects, worktreeStates: snapshotWorktreeStates, settledTabs: snapshotSettledTabs)
            applySnapshotRemoteDisplay(customName: snapshotCustomName, customIcon: snapshotCustomIcon, updatedAt: snapshotRemoteDisplayUpdatedAt)
            if let snapshotResources {
                resourceStore.applyCompleteManifest(snapshotResources)
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

        case .tabStatus(let tabId, let status, let resync):
            handleTabStatus(tabId: tabId, status: status, resync: resync)

        case .tabMeta(let tabId, let title, let totalCostUsd, let lastActivityAt, let lastMessageAt, let lastMessage, let messageCount, let pillColor):
            handleTabMeta(tabId: tabId, title: title, totalCostUsd: totalCostUsd, lastActivityAt: lastActivityAt, lastMessageAt: lastMessageAt, lastMessage: lastMessage, messageCount: messageCount, pillColor: pillColor)

        case .taskComplete(let tabId, _, _, let durationMs, let reason):
            handleTaskComplete(tabId: tabId, durationMs: durationMs, reason: reason)

        case .permissionRequest(let tabId, let instanceId, let questionId, let toolName, let toolInput, let options):
            handlePermissionRequest(tabId: tabId, instanceId: instanceId, questionId: questionId, toolName: toolName, toolInput: toolInput, options: options)

        case .permissionResolved(let tabId, let questionId):
            if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
                tabs[idx].permissionQueue.removeAll { $0.questionId == questionId }
            }

        case .transcript(let tabId, let requestId, let transcript, let error):
            handleTranscript(tabId: tabId, requestId: requestId, transcript: transcript, error: error)

        case .queueUpdate(let tabId, let prompts):
            if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
                tabs[idx].queuedPrompts = prompts
            }

        case .inputPrefill(let tabId, let text, let switchTo, let instanceId):
            handleInputPrefill(tabId: tabId, text: text, switchTo: switchTo, instanceId: instanceId)

        // Terminal events
        case .terminalOutput(let tabId, let instanceId, let data):
            TerminalOutputRouter.shared.route(tabId: tabId, instanceId: instanceId, data: data)

        case .terminalExit(let tabId, let instanceId, let exitCode):
            TerminalOutputRouter.shared.routeExit(tabId: tabId, instanceId: instanceId, exitCode: exitCode)

        case .terminalRestarted(let tabId, let instanceId):
            TerminalOutputRouter.shared.routeRestart(tabId: tabId, instanceId: instanceId)

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

        case .terminalActivity(let tabId, let instanceId, let active, let processLabel, let applications):
            if let instanceIndex = terminalInstances[tabId]?.firstIndex(where: { $0.id == instanceId }) {
                terminalInstances[tabId]?[instanceIndex].isRunning = active
                terminalInstances[tabId]?[instanceIndex].processLabel = processLabel
                terminalInstances[tabId]?[instanceIndex].applications = applications
            }
            if let tabIndex = tabs.firstIndex(where: { $0.id == tabId }) {
                if let projectedIndex = tabs[tabIndex].terminalInstances?.firstIndex(where: { $0.id == instanceId }) {
                    tabs[tabIndex].terminalInstances?[projectedIndex].isRunning = active
                    tabs[tabIndex].terminalInstances?[projectedIndex].processLabel = processLabel
                    tabs[tabIndex].terminalInstances?[projectedIndex].applications = applications
                }
                let instances = terminalInstances[tabId] ?? tabs[tabIndex].terminalInstances ?? []
                let otherInstances = instances.filter { $0.id != instanceId }
                tabs[tabIndex].hasRunningTerminal = active || otherInstances.contains { $0.isRunning == true }
            }

        // Engine events (structured)
        case .engineAgentState(let tabId, let instanceId, let agents, let metadataOmitted):
            // See SessionViewModel+AgentStateEvent.swift.
            applyAgentStateEvent(tabId: tabId, instanceId: instanceId,
                                 agents: agents, metadataOmitted: metadataOmitted)

        case .engineStatus(let tabId, let instanceId, let fields, _):
            mutateEngineInstance(tabId: tabId, instanceId: instanceId) { $0.statusFields = fields }

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

        case .engineToolStalled(let tabId, let instanceId, let toolId, _, _):
            _ = instanceId // unused post-#256, bare tabId is the key
            activeTools[tabId]?[toolId]?.isStalled = true

        case .engineBackgroundTaskStarted(let tabId, let instanceId, let taskId, let toolId, let command, let startedAt, let notifyOnComplete):
            handleBackgroundTaskStarted(
                tabId: tabId,
                instanceId: instanceId,
                task: BackgroundTaskState(taskId: taskId, toolId: toolId, command: command, startedAt: startedAt, notifyOnComplete: notifyOnComplete)
            )

        case .engineBackgroundTaskTerminal(let tabId, let instanceId, let taskId, let status, _, _, _, _, _):
            handleBackgroundTaskTerminal(tabId: tabId, instanceId: instanceId, taskId: taskId, status: status)

        case .engineSessionWorkStopped(let tabId, let instanceId, _, _, _, let stoppedTaskIds, _):
            for taskId in stoppedTaskIds {
                handleBackgroundTaskTerminal(tabId: tabId, instanceId: instanceId, taskId: taskId, status: "stopped")
            }

        case .engineRunStalled(let tabId, let instanceId, let stalledDuration, let lastActivity):
            handleEngineRunStalled(tabId: tabId, instanceId: instanceId, stalledDuration: stalledDuration, lastActivity: lastActivity)

        case .engineSteerInterruptedStream(let tabId, _, let blocksKept, let queuedSteers):
            // Scheduling notice only — no transcript mutation. The assistant
            // message already streamed is complete and correct as far as it
            // goes; the engine merely stopped asking for more so the steer
            // applies to the next turn. The steer itself arrives as
            // engineSteerInjected, which owns the divider and the pending-bubble
            // reconciliation, so appending anything here would double-render it.
            //
            // Logged rather than dropped: this is the one signal that explains
            // why an assistant message ended short, and without it a shortened
            // message is indistinguishable from a truncation in a diagnostic
            // read of the session.
            DiagnosticLog.log(
                "steer interrupted a streaming turn; the steer applies on the next turn",
                tag: "session",
                level: .info,
                fields: [
                    "tab_id": tabId,
                    "blocks_kept": String(blocksKept ?? 0),
                    "queued_steers": String(queuedSteers ?? 0),
                ]
            )

        case .engineRewindResult(_, _, let error):
            // Transactional rejection-only notice: the desktop sends this
            // ONLY on refusal (unknown entry, foreign-branch target,
            // non-user-turn target). Before this event existed, a refused
            // rewind produced ZERO feedback on iOS — no toast, no log,
            // nothing visibly happened when the user tapped Rewind.
            showToast(ToastMessage(
                style: .error,
                title: "Rewind not applied",
                detail: error ?? "The engine rejected this rewind."
            ))

        // No-op: engineToolComplete, engineScheduleFired, engineLlmCall are
        // decoded to prevent the 123 decode-errors/session diagnostic finding
        // but iOS does not yet render them.
        case .engineToolComplete, .engineScheduleFired, .engineLlmCall:
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

        case .engineError(let tabId, let instanceId, let message, _):
            handleEngineError(tabId: tabId, instanceId: instanceId, message: message)

        case .engineDialog(let tabId, let instanceId, let dialogId, let method, let title, let options, let defaultValue):
            _ = instanceId // unused post-#256
            engineDialogs[tabId] = EngineDialogInfo(dialogId: dialogId, method: method, title: title, options: options, defaultValue: defaultValue)

        case .engineDialogResolved(let tabId, let instanceId, _):
            _ = instanceId // unused post-#256
            engineDialogs[tabId] = nil

        case .engineMessageEnd(let tabId, let instanceId, let inputTokens, _, let contextPercent, _, _, _):
            handleEngineMessageEnd(tabId: tabId, instanceId: instanceId, inputTokens: inputTokens, contextPercent: contextPercent)

        case .transcriptPatch(let patch):
            if patch.conversationId != nil { handleDispatchTranscriptPatch(patch) } else { handleTranscriptPatch(patch) }

        case .transcriptPage(let page):
            if page.conversationId != nil { handleDispatchTranscriptPage(page) } else { handleTranscriptPage(page) }

        case .transcriptUnavailable(let tabId, let conversationId, let dispatchId, let isNewest, let reason):
            if let conversationId {
                handleDispatchTranscriptUnavailable(conversationId: conversationId, dispatchId: dispatchId ?? "", isNewest: isNewest, reason: reason)
            } else {
                handleTranscriptUnavailable(tabId: tabId, isNewest: isNewest, reason: reason)
            }

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

        case .desktopSettingsSnapshot(let settings, let schema, let groups, let newConversationPolicy, let themePolicy, let canManageEnvironment, let pages):
            // Per-server settings projection. Snapshot semantics
            // — replace the cached state wholesale. The view layer binds
            // to `viewModel.serverSettings` and re-renders the Settings
            // detail screen automatically when this assignment fires.
            //
            // Per-server scoping: this snapshot describes the currently-
            // connected server only. Switching to a different paired
            // server (via `switchToDevice`) clears the cache and the
            // new server's initial snapshot will repopulate it.
            // The phone's own keys (Personal and Device): carry over what the server still holds from
            // before they moved to the client, show this phone's own values,
            // and declare them to this connection.
            let clientOwnedKeys = schema.filter { PersonalPreferencesStore.isClientOwned(scope: $0.scope) }.map(\.key)
            PersonalPreferencesStore.adopt(from: settings, clientOwnedKeys: clientOwnedKeys)
            declarePersonalPreferences()
            registerPushAddress()
            serverSettings = ServerSettingsState(
                settings: PersonalPreferencesStore.overlay(settings, clientOwnedKeys: clientOwnedKeys),
                schema: schema,
                groups: groups,
                canManageEnvironment: canManageEnvironment ?? false,
                pages: pages ?? []
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
            // Enterprise theme policy — see SessionViewModel+ThemeSync.swift.
            applyThemePolicy(themePolicy)

        // Theme-pack sync — handlers in SessionViewModel+ThemeSync.swift.
        case .desktopThemeManifest(let themes, let hash):
            handleThemeManifest(themes: themes, hash: hash)
        case .desktopThemeAssetContent(let themeId, let slot, let ok, let sha256, let dataUrl):
            handleThemeAssetContent(themeId: themeId, slot: slot, ok: ok, sha256: sha256, dataUrl: dataUrl)

        // Worktree + integration bench events
        case .worktreeState(let states):
            handleWorktreeState(states)

        case .worktreeOpResult(let result):
            handleWorktreeOpResult(result)

        // FR-02 presence
        case .presence(let entries, let driving):
            handlePresence(entries: entries, driving: driving)

        // System Metrics — handler in SessionViewModel+SystemMetrics.swift.
        case .systemMetrics(let summary):
            handleSystemMetrics(summary)

        // Guided Questions — handler in SessionViewModel+Questions.swift.
        case .questionsState(let tabId, let state):
            handleQuestionsState(tabId: tabId, state: state)

        // Git events
        case .gitChangesResponse(let directory, let response):
            handleGitChangesResponse(directory: directory, response: response)

        case .gitBranchesResponse(let directory, let response):
            gitBranches[directory] = response
            pendingBranchRequest = nil
            pendingBranchPickerRepo = directory

        case .gitGraphResponse(let directory, let response):
            handleGitGraphResponse(directory: directory, response: response)

        case .gitDiffResponse(let response):
            handleGitDiffResponse(response)

        case .gitCommitResult(let result):
            handleGitCommitResult(result)

        case .gitStageResult(let result):
            handleGitStageResult(result)

        case .gitUnstageResult(let result):
            handleGitUnstageResult(result)

        case .gitCommitFilesResponse(let response):
            handleGitCommitFilesResponse(response)

        case .gitCommitFileDiffResponse(let response):
            handleGitCommitFileDiffResponse(response)

        // File explorer events
        case .fsDirListing(let directory, let response):
            handleFsDirListing(directory: directory, response: response)

        case .fsFileContent(let filePath, let response):
            handleFsFileContent(filePath: filePath, response: response)

        case .fsImageContent(let filePath, let dataUrl, let error):
            handleFsImageContent(filePath: filePath, dataUrl: dataUrl, error: error)

        case .fsWriteResult(_, let response):
            handleFsWriteResult(response)

        case .fsRenameResult(_, let newPath, let response):
            handleFsRenameResult(newPath: newPath, response: response)

        case .uploadAttachmentResult(let id, let name, let path, let correlationId, let contentHash, let error):
            handleUploadAttachmentResult(id: id, name: name, path: path, correlationId: correlationId, contentHash: contentHash, error: error)

        case .tabAttachments(let tabId, let attachments):
            let names = attachments.map { "\($0.type):\($0.name)" }.joined(separator: ", ")
            DiagnosticLog.log("tab attachments received", tag: "session.events", fields: [
                "tab_id": String(tabId.prefix(8)),
                "count": String(attachments.count),
                "reason": names
            ])
            tabAttachmentCache[tabId] = attachments

        case .conversationBranches(let tabId, let listing):
            handleConversationBranches(tabId: tabId, listing: listing)

        case .branchSwitchResult(let tabId, let error):
            handleBranchSwitchResult(tabId: tabId, error: error)

        // Command discovery events
        case .discoverCommandsResponse(let directory, let commands):
            discoveredCommands[directory] = commands

        // Diagnostic log request from desktop
        case .requestDiagnosticLogs(let sinceSeq):
            handleRequestDiagnosticLogs(sinceSeq: sinceSeq)

        // Resource events (D-007)
        case .engineResourceSnapshot(_, _, let kind, _, let rawItems, let producers):
            resourceStore.applySnapshot(kind: kind, rawItems: rawItems, producers: producers, complete: false)
        case .engineResourceDelta(_, _, let kind, _, let rawDelta):
            resourceStore.applyDelta(kind: kind, rawDelta: rawDelta)
        case .engineResourceItem(_, _, let kind, let rawItem):
            // Full item content delivered in response to a resource_get request.
            // Extract the id and content fields from the raw payload and forward
            // to the resource store to update the cached item. This allows
            // BriefingRow / NotificationsView to display full content on tap
            // without requiring the full body in every snapshot.
            if let id = rawItem["id"]?.value as? String,
               let content = rawItem["content"]?.value as? String {
                resourceStore.updateContent(
                    kind: kind,
                    producer: rawItem["producer"]?.value as? String ?? "",
                    resourceId: id,
                    content: content
                )
            }
        case .engineNotification:
            break
        case .resourceContent(let resourceId, let kind, let producer, let content):
            resourceStore.updateContent(kind: kind, producer: producer, resourceId: resourceId, content: content)

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

        case .desktopContextBreakdown(let tabId, let instanceId, let payload):
            handleContextBreakdown(tabId: tabId, instanceId: instanceId, payload: payload)

        case .desktopSlashModelTierIgnored:
            // Observation-only. DiagnosticLog.logEvent records the typed event;
            // this client applies no additional presentation policy.
            break
        case .promptResult(let tabId, let clientMsgId, let status, let error):
            handlePromptResult(tabId: tabId, clientMsgId: clientMsgId, status: status, error: error)

        case .backgroundTaskStopResult(let requestId, let taskId, let status, let error):
            handleBackgroundTaskStopResult(requestId: requestId, taskId: taskId, status: status, error: error)

        default:
            // Observed only: DiagnosticLog.logEvent above records it, and
            // nothing on the phone acts on it.
            break
        }
    }
}

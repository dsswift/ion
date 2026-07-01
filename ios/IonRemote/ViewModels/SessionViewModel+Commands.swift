import Foundation
import os

private let ionLog = Logger(subsystem: "com.sprague.ion.mobile", category: "engine")

// MARK: - Commands

extension SessionViewModel {

    func sync(intent: SendIntent = .automaticEssential) {
        send(.sync, intent: intent)
    }

    func sendSync() {
        send(.sync, intent: .automaticEssential)
    }

    // Unified prompt submit (`submit` / `sendPrompt`), the `instanceId` data
    // resolver (`resolveSubmitInstanceId`), and the unified per-tab model
    // override (`setModel`) live in SessionViewModel+Submit.swift. They were
    // moved there when the #256 follow-up collapsed the engine-vs-plain submit /
    // setModel forks into single branch-free paths and the unified bodies pushed
    // this file over the Swift 600-line cap. See CLAUDE.md → "When a file
    // exceeds the cap".

    func cancel(tabId: String) {
        send(.cancel(tabId: tabId), intent: .userInitiated)
    }

    func rewindConversation(tabId: String, messageId: String) {
        send(.rewind(tabId: tabId, messageId: messageId), intent: .userInitiated)
    }

    func forkFromMessage(tabId: String, messageId: String) {
        send(.forkFromMessage(tabId: tabId, messageId: messageId), intent: .userInitiated)
    }

    /// Rewind an engine-tab instance's conversation to the given message.
    /// Sends the `engine_rewind` remote command; the desktop stops the
    /// engine session, starts a fresh one, truncates the instance's
    /// messages, and replies with an `input_prefill` carrying the rewound
    /// user message (handled by the existing input_prefill path). Mirrors
    /// rewindConversation for CLI tabs but is per-instance.
    ///
    /// Sends a `userTurnIndex` alongside the message id: the 0-based ordinal
    /// of the target among role==.user messages in this instance. The desktop
    /// resolves the rewind point by id first, then falls back to the ordinal —
    /// which it always needs for iOS, because the target was rendered from an
    /// optimistic UUID the desktop never minted (see the desktop store's
    /// rewindEngineInstance). Computed over the instance's own message list so
    /// it is invariant to tool/assistant interleaving.
    @MainActor
    func engineRewindInstance(tabId: String, instanceId: String, messageId: String) {
        let messages = engineInstance(tabId: tabId, instanceId: instanceId)?.messages ?? []
        var userTurnIndex: Int? = nil
        var userCount = -1
        for message in messages {
            if message.role == .user {
                userCount += 1
                if message.id == messageId {
                    userTurnIndex = userCount
                    break
                }
            }
        }
        DiagnosticLog.log("CMD: engineRewindInstance tabId=\(tabId.prefix(8)) instanceId=\(instanceId.prefix(8)) messageId=\(messageId.prefix(16)) userTurnIndex=\(userTurnIndex.map(String.init) ?? "nil")")
        send(.engineRewind(tabId: tabId, instanceId: instanceId, messageId: messageId, userTurnIndex: userTurnIndex), intent: .userInitiated)
    }

    func respondPermission(tabId: String, questionId: String, optionId: String) {
        send(.respondPermission(tabId: tabId, questionId: questionId, optionId: optionId), intent: .userInitiated)
    }

    /// Answer an extension elicitation (ctx.elicit). `approved` true sends an
    /// empty approval payload; false sends cancelled. The desktop routes this to
    /// the engine's `elicitation_response`, unblocking the parked run. Optimistically
    /// remove the entry from the local queue so the card dismisses immediately.
    func respondElicitation(tabId: String, requestId: String, approved: Bool) {
        send(.respondElicitation(
            tabId: tabId,
            requestId: requestId,
            response: approved ? [:] : nil,
            cancelled: !approved
        ), intent: .userInitiated)
        if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            tabs[idx].elicitationQueue?.removeAll { $0.requestId == requestId }
        }
    }

    /// Dismiss a special permission card (AskUserQuestion/ExitPlanMode) without
    /// sending respond_permission -- the tool was already auto-allowed on desktop.
    func dismissSpecialPermission(tabId: String, questionId: String) {
        // Capture the entry's engine-instance scoping before removal so the
        // dismissal suppression can be keyed per sub-tab. Dismissing one
        // sub-tab's plan card must not block a sibling sub-tab's future
        // cards from rendering.
        var instanceId: String? = nil
        if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            instanceId = tabs[idx].permissionQueue.first(where: { $0.questionId == questionId })?.instanceId
            tabs[idx].permissionQueue.removeAll { $0.questionId == questionId }
        }
        if questionId.hasPrefix("restored-") {
            dismissedRestoredCards.insert(questionId)
        } else if let instanceId {
            // Post-#256: engine session key is bare tabId; instanceId is vestigial.
            // Insert bare tabId so snapshot sweep reads the same key.
            _ = instanceId // unused for keying post-#256
            DiagnosticLog.log("PERM: dismissSpecialPermission: tabId=\(tabId.prefix(8)) engine-instance dismissal (keyed bare tabId post-#256)")
            dismissedLiveSpecialTabs.insert(tabId)
        } else {
            // Live card dismissed -- block restoredSpecialCard from re-triggering
            DiagnosticLog.log("PERM: dismissSpecialPermission: tabId=\(tabId.prefix(8)) tab-scoped dismissal (no instanceId)")
            dismissedLiveSpecialTabs.insert(tabId)
        }
    }

    @MainActor
    func loadConversation(tabId: String) {
        guard !loadingConversation.contains(tabId) else { return }
        setConversationMessages(tabId: tabId, [])
        clearLiveText(tabId: tabId)
        conversationLoaded.remove(tabId)
        conversationHasMore.removeValue(forKey: tabId)
        conversationCursor.removeValue(forKey: tabId)
        conversationLoadFailed.remove(tabId)
        loadingConversation.insert(tabId)
        send(.loadConversation(tabId: tabId, before: nil), intent: .automaticEssential)
        startLoadTimer(tabId: tabId)
    }

    @MainActor
    func clearConversation(tabId: String) {
        setConversationMessages(tabId: tabId, [])
        conversationLoaded.remove(tabId)
        conversationHasMore.removeValue(forKey: tabId)
        conversationCursor.removeValue(forKey: tabId)
        loadingConversation.remove(tabId)
        cancelLoadTimer(tabId: tabId)
        dismissedRestoredCards = dismissedRestoredCards.filter { !$0.hasPrefix("restored-") }
    }

    func loadMoreMessages(tabId: String) {
        guard !loadingConversation.contains(tabId),
              conversationHasMore[tabId] == true,
              let cursor = conversationCursor[tabId] else { return }
        loadingConversation.insert(tabId)
        send(.loadConversation(tabId: tabId, before: cursor), intent: .automaticEssential)
        startLoadTimer(tabId: tabId)
    }

    func startLoadTimer(tabId: String) {
        conversationLoadTimers[tabId]?.cancel()
        conversationLoadTimers[tabId] = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(15))
            guard !Task.isCancelled, let self else { return }
            guard self.loadingConversation.contains(tabId) else { return }
            let retries = self.conversationLoadRetryCount[tabId] ?? 0
            if retries < 1 {
                // First timeout -- retry once
                self.conversationLoadRetryCount[tabId] = retries + 1
                let cursor = self.conversationCursor[tabId]
                self.send(.loadConversation(tabId: tabId, before: cursor), intent: .automaticEssential)
                self.startLoadTimer(tabId: tabId)
            } else {
                // Second timeout -- give up
                self.loadingConversation.remove(tabId)
                self.conversationLoadFailed.insert(tabId)
                self.conversationLoadTimers.removeValue(forKey: tabId)
                self.conversationLoadRetryCount.removeValue(forKey: tabId)
            }
        }
    }

    func cancelLoadTimer(tabId: String) {
        conversationLoadTimers[tabId]?.cancel()
        conversationLoadTimers.removeValue(forKey: tabId)
        conversationLoadRetryCount.removeValue(forKey: tabId)
    }

    func createTab(workingDirectory: String? = nil, pinToGroupId: String? = nil, profileId: String? = nil) {
        let dir = workingDirectory ?? defaultBaseDirectory
        awaitingLocalTabCreation = true
        // When `pinToGroupId` is supplied (e.g. via the per-group `+` button
        // in TabListView's group header), include it on the wire so the
        // desktop can create the tab inside that manual group with
        // groupPinned=true from the start — preventing the first prompt's
        // auto-group movement from yanking the tab away from the user's
        // explicit choice. When nil, the desktop falls back to its default
        // group placement (legacy behavior).
        // When `profileId` is supplied the desktop creates an engine tab with
        // that profile; nil creates a plain conversation tab. This is the
        // unified post-#256 wire path — both plain and engine tabs go through
        // the same `desktop_create_tab` command shape.
        send(.createTab(workingDirectory: dir, pinToGroupId: pinToGroupId, profileId: profileId), intent: .userInitiated)
    }

    func closeTab(_ tabId: String) {
        pendingCloseTabIds.insert(tabId)
        send(.closeTab(tabId: tabId), intent: .userInitiated)
        tabs.removeAll { $0.id == tabId }
        conversationInstances.removeValue(forKey: tabId)
        activeEngineInstance.removeValue(forKey: tabId)
        loadingConversation.remove(tabId)
        conversationLoaded.remove(tabId)
        conversationHasMore.removeValue(forKey: tabId)
        conversationCursor.removeValue(forKey: tabId)
    }

    func setPermissionMode(tabId: String, mode: PermissionMode) {
        // Optimistic local update for responsive UI
        if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            tabs[idx].permissionMode = mode
        }
        send(.setPermissionMode(tabId: tabId, mode: mode), intent: .userInitiated)
    }

    /// Whether the desktop's global "Enable extended thinking" setting is on.
    /// Reads the projectable `thinkingEnabled` value from the latest desktop
    /// settings snapshot; defaults to false until a snapshot arrives.
    var thinkingGloballyEnabled: Bool {
        (desktopSettings?.currentValue(for: "thinkingEnabled")?.value as? Bool) ?? false
    }

    /// Set the per-conversation extended-thinking effort. Optimistically
    /// updates the active conversation instance, then sends the
    /// desktop_set_thinking_effort command so the next prompt from either
    /// client carries the level. effort is "off"|"low"|"medium"|"high".
    ///
    /// WI-002 (#259): every tab — plain or extension-hosted — stores its
    /// control fields on the single ConversationInstanceInfo (post-#256
    /// unification). There is no tab-type branch; the instance is the
    /// single authoritative home.
    @MainActor
    func setThinkingEffort(tabId: String, effort: String) {
        mutateEngineInstance(tabId: tabId, instanceId: nil) { inst in
            inst.thinkingEffort = effort == "off" ? nil : effort
        }
        send(.setThinkingEffort(tabId: tabId, effort: effort), intent: .userInitiated)
    }

    // The plan→implement flow (`implementPlan`) lives in
    // SessionViewModel+ImplementPlan.swift to keep this file under the
    // Swift size cap. See CLAUDE.md → "When a file exceeds the cap".

    // Tab-group commands (setTabGroupMode, moveTabToGroup,
    // moveTabToGroupAndPin, toggleTabGroupPin, reorderTabGroups) live in
    // SessionViewModel+TabGroupCommands.swift to keep this file under the
    // Swift size cap. See CLAUDE.md → "When a file exceeds the cap".

    // MARK: - Terminal Commands

    func createTerminalTab(workingDirectory: String? = nil) {
        let dir = workingDirectory ?? defaultBaseDirectory
        awaitingLocalTabCreation = true
        send(.createTerminalTab(workingDirectory: dir), intent: .userInitiated)
    }

    // Engine Commands live in SessionViewModel+EngineCommands.swift to keep
    // this file under the Swift 600-line cap after submitEnginePrompt grew
    // an optimistic-insert block. See CLAUDE.md → "When a file exceeds the
    // cap".

    // Engine instance management commands (addEngineInstance, removeEngineInstance,
    // moveEngineInstance, selectEngineInstance, renameEngineInstance) were removed
    // in #256 (single-instance collapse). The desktop already silently ignored
    // the corresponding wire commands; removing the iOS send path completes cleanup.

    // loadEngineConversation removed (WI-004 / #259). History load is unified:
    // loadConversation handles every tab via loadConversationHistory().

    func sendTerminalInput(tabId: String, instanceId: String, data: String) {
        send(.terminalInput(tabId: tabId, instanceId: instanceId, data: data), intent: .userInitiated)
    }

    func sendTerminalResize(tabId: String, instanceId: String, cols: Int, rows: Int) {
        send(.terminalResize(tabId: tabId, instanceId: instanceId, cols: cols, rows: rows), intent: .userInitiated)
    }

    func addTerminalInstance(tabId: String) {
        send(.terminalAddInstance(tabId: tabId), intent: .userInitiated)
    }

    func removeTerminalInstance(tabId: String, instanceId: String) {
        send(.terminalRemoveInstance(tabId: tabId, instanceId: instanceId), intent: .userInitiated)
    }

    func selectTerminalInstance(tabId: String, instanceId: String) {
        activeTerminalInstance[tabId] = instanceId
        send(.terminalSelectInstance(tabId: tabId, instanceId: instanceId), intent: .userInitiated)
    }

    func requestTerminalSnapshot(tabId: String) {
        send(.requestTerminalSnapshot(tabId: tabId), intent: .automaticEssential)
    }

    func renameTab(tabId: String, customTitle: String?) {
        if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            tabs[idx].customTitle = customTitle
        }
        send(.renameTab(tabId: tabId, customTitle: customTitle), intent: .userInitiated)
    }

    func setPillColor(tabId: String, color: String?) {
        // Optimistic local update -- the snapshot will confirm on the next sync.
        if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            tabs[idx].pillColor = color
        }
        send(.setPillColor(tabId: tabId, pillColor: color), intent: .userInitiated)
    }

    func setPillIcon(tabId: String, icon: String?) {
        // Optimistic local update -- the snapshot will confirm on the next sync.
        if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            tabs[idx].pillIcon = icon
        }
        send(.setPillIcon(tabId: tabId, pillIcon: icon), intent: .userInitiated)
    }

    func renameTerminalInstance(tabId: String, instanceId: String, label: String) {
        terminalInstanceLabels["\(tabId):\(instanceId)"] = label
        send(.renameTerminalInstance(tabId: tabId, instanceId: instanceId, label: label), intent: .userInitiated)
    }

    func terminalInstanceLabel(tabId: String, instanceId: String, fallback: String) -> String {
        terminalInstanceLabels["\(tabId):\(instanceId)"] ?? fallback
    }

    // MARK: - Git Commands

    func requestGitChanges(directory: String) {
        send(.gitChanges(directory: directory), intent: .automaticEssential)
    }

    /// Request git changes for every unique tab working directory that doesn't
    /// already have cached data. Called when the "Show Git Info" toggle is
    /// enabled so rows populate without waiting for the next watcher event.
    func requestMissingGitChanges() {
        let dirs = Set(tabs.map(\.workingDirectory).filter { !$0.isEmpty })
        for dir in dirs where gitChanges[dir] == nil {
            requestGitChanges(directory: dir)
        }
    }

    /// Request git changes for every unique tab working directory — including
    /// ones that already have cached (potentially stale) data. Called when the
    /// app foregrounds and when the tab list appears, so the user sees fresh
    /// branch + ahead/behind info on every appear. The desktop's git watcher
    /// is best-effort and can silently stop delivering events; this guarantees
    /// the iOS tab list reflects current state.
    func requestAllGitChanges() {
        let dirs = Set(tabs.map(\.workingDirectory).filter { !$0.isEmpty })
        for dir in dirs {
            requestGitChanges(directory: dir)
        }
    }

    func requestGitGraph(directory: String, skip: Int? = nil, limit: Int? = nil) {
        send(.gitGraph(directory: directory, skip: skip, limit: limit), intent: .userInitiated)
    }

    func requestGitDiff(directory: String, path: String, staged: Bool) {
        gitDiffLoading = true
        send(.gitDiff(directory: directory, path: path, staged: staged), intent: .userInitiated)
    }

    func gitStage(directory: String, paths: [String]) {
        send(.gitStage(directory: directory, paths: paths), intent: .userInitiated)
    }

    func gitUnstage(directory: String, paths: [String]) {
        send(.gitUnstage(directory: directory, paths: paths), intent: .userInitiated)
    }

    func gitCommit(directory: String, message: String) {
        send(.gitCommit(directory: directory, message: message), intent: .userInitiated)
    }

    func gitDiscard(directory: String, paths: [String]) {
        send(.gitDiscard(directory: directory, paths: paths), intent: .userInitiated)
    }

    func gitFetch(directory: String) {
        send(.gitFetch(directory: directory), intent: .userInitiated)
    }

    func gitPull(directory: String) {
        send(.gitPull(directory: directory), intent: .userInitiated)
    }

    func gitPush(directory: String) {
        send(.gitPush(directory: directory), intent: .userInitiated)
    }

    func requestGitCommitFiles(directory: String, hash: String) {
        send(.gitCommitFiles(directory: directory, hash: hash), intent: .userInitiated)
    }

    func requestGitCommitFileDiff(directory: String, hash: String, path: String) {
        send(.gitCommitFileDiff(directory: directory, hash: hash, path: path), intent: .userInitiated)
    }

    // MARK: - File Explorer Commands

    /// Upload an image from the iOS device to the desktop as a temp file.
    func uploadAttachment(dataUrl: String, name: String, correlationId: String) {
        send(.uploadAttachment(dataUrl: dataUrl, name: name, correlationId: correlationId), intent: .userInitiated)
    }

    func requestFsListDir(directory: String, includeHidden: Bool = false) {
        fileListingLoading.insert(directory)
        send(.fsListDir(directory: directory, includeHidden: includeHidden), intent: .userInitiated)
    }

    func requestFsReadFile(filePath: String) {
        fileContentLoading.insert(filePath)
        send(.fsReadFile(filePath: filePath), intent: .userInitiated)
    }

    func requestFsWriteFile(filePath: String, content: String) {
        send(.fsWriteFile(filePath: filePath, content: content), intent: .userInitiated)
    }

    /// Rename a file or directory on the paired desktop. Fire-and-forget;
    /// the result arrives as `.fsRenameResult` which the event handler
    /// turns into a refreshed `fsListDir` on the parent directory of
    /// `newPath` (and surfaces errors via `fileRenameResult`).
    func requestFsRename(oldPath: String, newPath: String) {
        send(.fsRename(oldPath: oldPath, newPath: newPath), intent: .userInitiated)
    }

    func requestLoadAttachments(tabId: String) {
        let oldCount = tabAttachmentCache[tabId]?.count ?? -1
        DiagnosticLog.log("ATTACH: requestLoadAttachments tabId=\(tabId.prefix(8)) oldCacheCount=\(oldCount) clearing")
        tabAttachmentCache.removeValue(forKey: tabId)
        send(.loadAttachments(tabId: tabId), intent: .automaticEssential)
    }

    // MARK: - Command Discovery

    func discoverCommands(directory: String) {
        guard !directory.isEmpty else { return }
        send(.discoverCommands(directory: directory), intent: .automaticEssential)
    }

    // MARK: - Voice Config

    /// Send the current voice configuration to the desktop.
    /// Called on initial connection (snapshot) and when voice settings change.
    /// Fire-and-forget: rides the next snapshot if not connected at call time.
    @MainActor
    func sendVoiceConfig() {
        let prompt = voiceService.voiceMode == .desktopAssisted ? voiceService.voiceSystemPrompt : nil
        send(.voiceConfig(
            enabled: voiceService.isEnabled,
            mode: voiceService.voiceMode.rawValue,
            systemPrompt: prompt
        ), intent: .automaticFireAndForget) // rides next snapshot if disconnected
    }

    /// Write a single projectable desktop setting on the currently-paired
    /// desktop. The desktop validates the key against its allowlist and
    /// the value's type against the declared schema, persists the
    /// change, and broadcasts a fresh `desktopSettingsSnapshot` back to
    /// every paired iOS device — including this one — which is how
    /// `desktopSettings` is updated.
    ///
    /// Optimistic UI: SwiftUI Toggle bindings call this on every flip;
    /// the round-trip is short enough on LAN that we don't bother
    /// pre-updating local state. The next snapshot wins. If the desktop
    /// rejects the write (unknown key, wrong type), no snapshot fires
    /// and the SwiftUI control re-renders with the cached prior value
    /// on the next state read.
    @MainActor
    func setDesktopSetting(key: String, value: AnyCodable) {
        send(.setDesktopSetting(key: key, value: value), intent: .userInitiated)
    }

    /// Send the current focus state to the desktop for intercept routing.
    /// The desktop stores the (tabId, interceptEnabled) pair in `deviceFocusMap`
    /// and uses it to decide whether this device's active tab is a valid
    /// target for redirect-level intercepts.
    ///
    /// `tabId: nil` signals that the app is backgrounded (no active tab).
    /// `interceptEnabled` reads the iOS-local UserDefaults preference,
    /// defaulting to `true` so new installs participate in intercepts
    /// without any configuration step.
    func sendReportFocus(tabId: String?) {
        let interceptEnabled = UserDefaults.standard.object(forKey: "interceptEnabled") as? Bool ?? true
        DiagnosticLog.log("CMD: report_focus tabId=\(tabId?.prefix(8) ?? "nil") interceptEnabled=\(interceptEnabled)")
        Task { @MainActor [weak self] in
            self?.focusedTabId = tabId
        }
        send(.reportFocus(tabId: tabId, interceptEnabled: interceptEnabled), intent: .automaticEssential)
    }

    // MARK: - Send

    /// Send a command with an explicit intent classification.
    ///
    /// Intent drives queueing and error visibility:
    ///
    ///   `.userInitiated`         User tapped or typed. Transport absent -> "Not
    ///                            connected" toast; send error -> "Send failed" toast.
    ///
    ///   `.automaticEssential`    Background send the screen requires. Not connected
    ///                            -> enqueue deduped by command-identity key
    ///                            (last-write-wins); drains once on first snapshot.
    ///                            Connected but throws -> log only, no toast.
    ///
    ///   `.automaticFireAndForget` Background send that self-heals. Not connected
    ///                            -> drop silently (log only). Connected but throws
    ///                            -> log only, no toast.
    ///
    /// Safe default: `.automaticEssential`. Pass `.userInitiated` at every
    /// call site the user directly initiated. Pass `.automaticFireAndForget`
    /// only with a one-line reason comment at the call site.
    func send(_ command: RemoteCommand, intent: SendIntent = .automaticEssential) {
        DiagnosticLog.logCommand(command)

        switch intent {
        case .userInitiated:
            guard let transport else {
                DiagnosticLog.log("CMD: dropped (no transport) intent=userInitiated")
                Task { @MainActor [weak self] in
                    self?.showToast(ToastMessage(style: .error, title: "Not connected", detail: "Command could not be sent"))
                }
                return
            }
            Task { [weak self] in
                do {
                    try await transport.send(command)
                } catch {
                    let detail = error.localizedDescription
                    await MainActor.run {
                        self?.showToast(ToastMessage(style: .error, title: "Send failed", detail: detail))
                    }
                }
            }

        case .automaticEssential:
            guard connectionState == .connected, let transport else {
                let key = command.essentialKey ?? "unknown:\(command)"
                DiagnosticLog.log("CMD: essential not connected, deferring key=\(key) state=\(connectionState.rawValue)")
                enqueueEssential(key: key, command: command)
                return
            }
            Task { [weak self] in
                do {
                    try await transport.send(command)
                } catch {
                    DiagnosticLog.log("CMD: essential send error (no toast): \(error.localizedDescription)")
                }
                _ = self
            }

        case .automaticFireAndForget:
            guard connectionState == .connected, let transport else {
                DiagnosticLog.log("CMD: fire-and-forget dropped (not connected) state=\(connectionState.rawValue)")
                return
            }
            Task { [weak self] in
                do {
                    try await transport.send(command)
                } catch {
                    DiagnosticLog.log("CMD: fire-and-forget send error (no toast): \(error.localizedDescription)")
                }
                _ = self
            }
        }
    }
}

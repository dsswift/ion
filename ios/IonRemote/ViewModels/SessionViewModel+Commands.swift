import Foundation
import os

private let ionLog = Logger(subsystem: "com.sprague.ion.mobile", category: "engine")

// MARK: - Commands

extension SessionViewModel {

    func sync() {
        send(.sync)
    }

    func sendSync() {
        send(.sync)
    }

    func sendPrompt(tabId: String, text: String, attachments: [CommandAttachment]? = nil) {
        let clientMsgId = UUID().uuidString
        send(.prompt(tabId: tabId, text: text, clientMsgId: clientMsgId, attachments: attachments))
        // Optimistic local insert so the user's message appears immediately
        // (dismisses empty state, enables scroll-to-bottom) rather than waiting
        // for the desktop to echo it back via messageAdded.
        if conversationLoaded.contains(tabId) {
            let optimistic = Message(
                id: clientMsgId,
                role: .user,
                content: text,
                // Milliseconds since epoch — matches every other timestamp
                // insertion in iOS (SessionViewModel+EngineEvents.swift,
                // +EventHandlers.swift, NormalizedEvent+Lifecycle.swift,
                // RemoteCommand+Encode.swift) and the ms shape used by
                // MessageBubble.relativeTimestamp which divides by 1000 to
                // reconstruct seconds for Date(timeIntervalSince1970:).
                // Without the * 1000 the optimistic bubble briefly shows
                // "56 years ago" before the desktop echoes the canonical
                // message_added back and id-replacement fixes it.
                timestamp: Date().timeIntervalSince1970 * 1000,
                source: .remote
            )
            if var existing = messages[tabId] {
                existing.append(optimistic)
                messages[tabId] = existing
            } else {
                messages[tabId] = [optimistic]
            }
            messageCountByTab[tabId] = messages[tabId]?.count ?? 0
        }
        // Optimistic status: show activity indicator immediately so the user
        // sees "Thinking…" rather than staring at their sent message while the
        // prompt travels over the relay to the desktop engine.
        // Mirrors desktop send-slice.ts which sets 'connecting' on send.
        // Guard against downgrading from .running (queued-prompt case).
        if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            if tabs[idx].status != .running {
                tabs[idx].status = .connecting
            }
        }
    }

    func cancel(tabId: String) {
        send(.cancel(tabId: tabId))
    }

    func rewindConversation(tabId: String, messageId: String) {
        send(.rewind(tabId: tabId, messageId: messageId))
    }

    func forkFromMessage(tabId: String, messageId: String) {
        send(.forkFromMessage(tabId: tabId, messageId: messageId))
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
        send(.engineRewind(tabId: tabId, instanceId: instanceId, messageId: messageId, userTurnIndex: userTurnIndex))
    }

    func respondPermission(tabId: String, questionId: String, optionId: String) {
        send(.respondPermission(tabId: tabId, questionId: questionId, optionId: optionId))
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
            // Live engine-instance card dismissed -- suppress snapshot
            // re-injection for this sub-tab only ("tabId:instanceId" key).
            DiagnosticLog.log("PERM: dismissSpecialPermission: tabId=\(tabId.prefix(8)) instance-scoped dismissal instanceId=\(instanceId.prefix(8))")
            dismissedLiveSpecialTabs.insert("\(tabId):\(instanceId)")
        } else {
            // Live card dismissed -- block restoredSpecialCard from re-triggering
            DiagnosticLog.log("PERM: dismissSpecialPermission: tabId=\(tabId.prefix(8)) tab-scoped dismissal (no instanceId)")
            dismissedLiveSpecialTabs.insert(tabId)
        }
    }

    func loadConversation(tabId: String) {
        guard !loadingConversation.contains(tabId) else { return }
        messages.removeValue(forKey: tabId)
        messageCountByTab.removeValue(forKey: tabId)
        liveText.removeValue(forKey: tabId)
        conversationLoaded.remove(tabId)
        conversationHasMore.removeValue(forKey: tabId)
        conversationCursor.removeValue(forKey: tabId)
        conversationLoadFailed.remove(tabId)
        loadingConversation.insert(tabId)
        send(.loadConversation(tabId: tabId, before: nil))
        startLoadTimer(tabId: tabId)
    }

    func clearConversation(tabId: String) {
        messages.removeValue(forKey: tabId)
        messageCountByTab.removeValue(forKey: tabId)
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
        send(.loadConversation(tabId: tabId, before: cursor))
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
                self.send(.loadConversation(tabId: tabId, before: cursor))
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

    func createTab(workingDirectory: String? = nil, pinToGroupId: String? = nil) {
        let dir = workingDirectory ?? defaultBaseDirectory
        awaitingLocalTabCreation = true
        // When `pinToGroupId` is supplied (e.g. via the per-group `+` button
        // in TabListView's group header), include it on the wire so the
        // desktop can create the tab inside that manual group with
        // groupPinned=true from the start — preventing the first prompt's
        // auto-group movement from yanking the tab away from the user's
        // explicit choice. When nil, the desktop falls back to its default
        // group placement (legacy behavior).
        send(.createTab(workingDirectory: dir, pinToGroupId: pinToGroupId))
    }

    func closeTab(_ tabId: String) {
        pendingCloseTabIds.insert(tabId)
        send(.closeTab(tabId: tabId))
        tabs.removeAll { $0.id == tabId }
        liveText.removeValue(forKey: tabId)
        messages.removeValue(forKey: tabId)
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
        send(.setPermissionMode(tabId: tabId, mode: mode))
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
        send(.createTerminalTab(workingDirectory: dir))
    }

    // Engine Commands live in SessionViewModel+EngineCommands.swift to keep
    // this file under the Swift 600-line cap after submitEnginePrompt grew
    // an optimistic-insert block. See CLAUDE.md → "When a file exceeds the
    // cap".

    // MARK: - Engine Instance Commands

    func addEngineInstance(tabId: String) {
        send(.engineAddInstance(tabId: tabId))
    }

    func removeEngineInstance(tabId: String, instanceId: String) {
        send(.engineRemoveInstance(tabId: tabId, instanceId: instanceId))
    }

    func moveEngineInstance(sourceTabId: String, instanceId: String, targetTabId: String) {
        ionLog.info("moveEngineInstance: \(sourceTabId):\(instanceId) -> \(targetTabId)")
        // Optimistic local update: move instance between conversationInstances dictionaries
        if var srcInstances = conversationInstances[sourceTabId],
           let idx = srcInstances.firstIndex(where: { $0.id == instanceId }) {
            let inst = srcInstances.remove(at: idx)
            conversationInstances[sourceTabId] = srcInstances.isEmpty ? nil : srcInstances
            var tgtInstances = conversationInstances[targetTabId] ?? []
            tgtInstances.append(inst)
            conversationInstances[targetTabId] = tgtInstances
            // Update active instance on target
            activeEngineInstance[targetTabId] = instanceId
            // Update active instance on source (last remaining or nil)
            if srcInstances.isEmpty {
                activeEngineInstance.removeValue(forKey: sourceTabId)
            } else if activeEngineInstance[sourceTabId] == instanceId {
                activeEngineInstance[sourceTabId] = srcInstances.last?.id
            }
        }
        send(.engineMoveInstance(sourceTabId: sourceTabId, instanceId: instanceId, targetTabId: targetTabId))
    }

    func selectEngineInstance(tabId: String, instanceId: String) {
        activeEngineInstance[tabId] = instanceId
        send(.engineSelectInstance(tabId: tabId, instanceId: instanceId))
        // Load conversation for the newly selected instance
        loadEngineConversation(tabId: tabId)
    }

    func renameEngineInstance(tabId: String, instanceId: String, label: String) {
        // Update local state immediately
        if var instances = conversationInstances[tabId] {
            if let idx = instances.firstIndex(where: { $0.id == instanceId }) {
                instances[idx].label = label
                conversationInstances[tabId] = instances
            }
        }
        send(.engineRenameInstance(tabId: tabId, instanceId: instanceId, label: label))
    }

    func loadEngineConversation(tabId: String) {
        let instanceId = activeEngineInstance[tabId]
        let instList = conversationInstances[tabId]?.map(\.id) ?? []
        DiagnosticLog.log("LOAD-CONV: loadEngineConversation tabId=\(tabId.prefix(8)) instanceId=\(instanceId?.prefix(8) ?? "nil") allInstances=\(instList.map { $0.prefix(8) })")
        send(.loadEngineConversation(tabId: tabId, instanceId: instanceId))
    }

    func sendTerminalInput(tabId: String, instanceId: String, data: String) {
        send(.terminalInput(tabId: tabId, instanceId: instanceId, data: data))
    }

    func sendTerminalResize(tabId: String, instanceId: String, cols: Int, rows: Int) {
        send(.terminalResize(tabId: tabId, instanceId: instanceId, cols: cols, rows: rows))
    }

    func addTerminalInstance(tabId: String) {
        send(.terminalAddInstance(tabId: tabId))
    }

    func removeTerminalInstance(tabId: String, instanceId: String) {
        send(.terminalRemoveInstance(tabId: tabId, instanceId: instanceId))
    }

    func selectTerminalInstance(tabId: String, instanceId: String) {
        activeTerminalInstance[tabId] = instanceId
        send(.terminalSelectInstance(tabId: tabId, instanceId: instanceId))
    }

    func requestTerminalSnapshot(tabId: String) {
        send(.requestTerminalSnapshot(tabId: tabId))
    }

    func renameTab(tabId: String, customTitle: String?) {
        if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            tabs[idx].customTitle = customTitle
        }
        send(.renameTab(tabId: tabId, customTitle: customTitle))
    }

    func setPillColor(tabId: String, color: String?) {
        // Optimistic local update — the snapshot will confirm on the next sync.
        if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            tabs[idx].pillColor = color
        }
        send(.setPillColor(tabId: tabId, pillColor: color))
    }

    func setPillIcon(tabId: String, icon: String?) {
        // Optimistic local update — the snapshot will confirm on the next sync.
        if let idx = tabs.firstIndex(where: { $0.id == tabId }) {
            tabs[idx].pillIcon = icon
        }
        send(.setPillIcon(tabId: tabId, pillIcon: icon))
    }

    func renameTerminalInstance(tabId: String, instanceId: String, label: String) {
        terminalInstanceLabels["\(tabId):\(instanceId)"] = label
        send(.renameTerminalInstance(tabId: tabId, instanceId: instanceId, label: label))
    }

    func terminalInstanceLabel(tabId: String, instanceId: String, fallback: String) -> String {
        terminalInstanceLabels["\(tabId):\(instanceId)"] ?? fallback
    }

    // MARK: - Git Commands

    func requestGitChanges(directory: String) {
        send(.gitChanges(directory: directory))
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
        send(.gitGraph(directory: directory, skip: skip, limit: limit))
    }

    func requestGitDiff(directory: String, path: String, staged: Bool) {
        gitDiffLoading = true
        send(.gitDiff(directory: directory, path: path, staged: staged))
    }

    func gitStage(directory: String, paths: [String]) {
        send(.gitStage(directory: directory, paths: paths))
    }

    func gitUnstage(directory: String, paths: [String]) {
        send(.gitUnstage(directory: directory, paths: paths))
    }

    func gitCommit(directory: String, message: String) {
        send(.gitCommit(directory: directory, message: message))
    }

    func gitDiscard(directory: String, paths: [String]) {
        send(.gitDiscard(directory: directory, paths: paths))
    }

    func gitFetch(directory: String) {
        send(.gitFetch(directory: directory))
    }

    func gitPull(directory: String) {
        send(.gitPull(directory: directory))
    }

    func gitPush(directory: String) {
        send(.gitPush(directory: directory))
    }

    func requestGitCommitFiles(directory: String, hash: String) {
        send(.gitCommitFiles(directory: directory, hash: hash))
    }

    func requestGitCommitFileDiff(directory: String, hash: String, path: String) {
        send(.gitCommitFileDiff(directory: directory, hash: hash, path: path))
    }

    // MARK: - File Explorer Commands

    /// Upload an image from the iOS device to the desktop as a temp file.
    func uploadAttachment(dataUrl: String, name: String, correlationId: String) {
        send(.uploadAttachment(dataUrl: dataUrl, name: name, correlationId: correlationId))
    }

    func requestFsListDir(directory: String, includeHidden: Bool = false) {
        fileListingLoading.insert(directory)
        send(.fsListDir(directory: directory, includeHidden: includeHidden))
    }

    func requestFsReadFile(filePath: String) {
        fileContentLoading.insert(filePath)
        send(.fsReadFile(filePath: filePath))
    }

    func requestFsWriteFile(filePath: String, content: String) {
        send(.fsWriteFile(filePath: filePath, content: content))
    }

    /// Rename a file or directory on the paired desktop. Fire-and-forget;
    /// the result arrives as `.fsRenameResult` which the event handler
    /// turns into a refreshed `fsListDir` on the parent directory of
    /// `newPath` (and surfaces errors via `fileRenameResult`).
    func requestFsRename(oldPath: String, newPath: String) {
        send(.fsRename(oldPath: oldPath, newPath: newPath))
    }

    func requestLoadAttachments(tabId: String) {
        let oldCount = tabAttachmentCache[tabId]?.count ?? -1
        DiagnosticLog.log("ATTACH: requestLoadAttachments tabId=\(tabId.prefix(8)) oldCacheCount=\(oldCount) clearing")
        tabAttachmentCache.removeValue(forKey: tabId)
        send(.loadAttachments(tabId: tabId))
    }

    // MARK: - Command Discovery

    func discoverCommands(directory: String) {
        guard !directory.isEmpty else { return }
        send(.discoverCommands(directory: directory))
    }

    // MARK: - Voice Config

    /// Send the current voice configuration to the desktop.
    /// Called on initial connection (snapshot) and when voice settings change.
    @MainActor
    func sendVoiceConfig() {
        let prompt = voiceService.voiceMode == .desktopAssisted ? voiceService.voiceSystemPrompt : nil
        send(.voiceConfig(
            enabled: voiceService.isEnabled,
            mode: voiceService.voiceMode.rawValue,
            systemPrompt: prompt
        ))
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
        send(.setDesktopSetting(key: key, value: value))
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
        send(.reportFocus(tabId: tabId, interceptEnabled: interceptEnabled))
    }

    // MARK: - Send

    func send(_ command: RemoteCommand) {        DiagnosticLog.logCommand(command)
        guard let transport else {
            DiagnosticLog.log("CMD: dropped (no transport)")
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
    }
}

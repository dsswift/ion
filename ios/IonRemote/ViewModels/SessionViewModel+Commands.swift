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
        DiagnosticLog.log("engine rewind instance", tag: "session.commands", fields: [
            "tab_id": String(tabId.prefix(8)),
            "reason": String(instanceId.prefix(8)),
            "status": String(messageId.prefix(16)),
            "turn": userTurnIndex.map(String.init) ?? "nil"
        ])
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
            DiagnosticLog.log("dismiss special permission engine-instance", tag: "session.commands", fields: [
                "tab_id": String(tabId.prefix(8))
            ])
            dismissedLiveSpecialTabs.insert(tabId)
        } else {
            // Live card dismissed -- block restoredSpecialCard from re-triggering
            DiagnosticLog.log("dismiss special permission tab-scoped", tag: "session.commands", fields: [
                "tab_id": String(tabId.prefix(8))
            ])
            dismissedLiveSpecialTabs.insert(tabId)
        }
    }

    @MainActor
    func loadConversation(tabId: String) {
        guard !loadingConversation.contains(tabId) else { return }
        // Do NOT clear the transcript here. Clearing before the fetch left the
        // conversation blank for the whole round-trip (and indefinitely if the
        // response was dropped). The existing messages stay visible until the
        // replacement page arrives; handleConversationHistory replaces them
        // wholesale on the first page (the response echoes this request's
        // nil cursor as `before == nil`).
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
            // First load attempt retries faster (5s); the post-retry wait stays
            // at 15s. With commit 1's truncation fix, a 5s first retry makes
            // recovery from any transient failure noticeably quicker.
            let retriesSoFar = self?.conversationLoadRetryCount[tabId] ?? 0
            let waitSeconds = retriesSoFar < 1 ? 5 : 15
            try? await Task.sleep(for: .seconds(waitSeconds))
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
        // Route through the confirm-or-resend tracker rather than a fire-once
        // `send(_:intent: .userInitiated)`: a create dropped into a wedged
        // transport succeeds locally without throwing and is otherwise lost.
        // The `clientCmdId` correlates the desktop_tab_created echo back to this
        // pending create (also driving navigation). See SessionViewModel+PendingCreate.
        let clientCmdId = UUID().uuidString
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
        sendTrackedCreate(
            .createTab(workingDirectory: dir, pinToGroupId: pinToGroupId, profileId: profileId, clientCmdId: clientCmdId),
            clientCmdId: clientCmdId
        )
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
        // Confirm-or-resend tracked, same rationale as createTab.
        let clientCmdId = UUID().uuidString
        sendTrackedCreate(
            .createTerminalTab(workingDirectory: dir, clientCmdId: clientCmdId),
            clientCmdId: clientCmdId
        )
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

    /// Request an on-demand context breakdown from the desktop for a tab.
    /// The desktop forwards get_context_breakdown to the engine; the result
    /// arrives as desktop_context_breakdown and populates inst.contextBreakdown.
    func requestContextBreakdown(tabId: String) {
        send(.requestContextBreakdown(tabId: tabId), intent: .automaticEssential)
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

    // File-explorer commands (uploadAttachment, requestFsListDir,
    // requestFsReadFile, requestFsWriteFile, requestFsRename,
    // requestLoadAttachments) live in SessionViewModel+FsCommands.swift,
    // extracted to keep this file under the 600-line Swift cap.

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
        DiagnosticLog.log("report focus", tag: "session.commands", fields: [
            "tab_id": tabId?.prefix(8).description ?? "nil",
            "status": String(interceptEnabled)
        ])
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
    ///   `.userInitiated`         User tapped or typed. Transport absent or send
    ///                            error/timeout -> if the command has an
    ///                            `essentialKey` (e.g. a prompt) it is re-enqueued
    ///                            for the reconnect flush and a "queued" toast is
    ///                            shown; otherwise an error toast. A user message
    ///                            is never silently dropped.
    ///
    ///   `.automaticEssential`    Background send the screen requires. Not connected
    ///                            -> enqueue deduped by command-identity key
    ///                            (last-write-wins); drains once on first snapshot.
    ///                            Connected but throws -> re-enqueue for the next
    ///                            flush (no toast).
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
                // No transport object at all (mid soft-reconnect teardown, or
                // unpaired). Queueable commands — critically, user prompts —
                // are deferred to the reconnect flush instead of dropped: the
                // optimistic UI stays and the command delivers on reconnect.
                // The queue is cleared on hard disconnect/unpair, so a truly
                // undeliverable command doesn't fire against a new pairing.
                if let key = command.essentialKey {
                    DiagnosticLog.log("user command deferred (no transport)", tag: "session.commands", level: .warn, fields: [
                        "reason": key
                    ])
                    enqueueEssential(key: key, command: command)
                    Task { @MainActor [weak self] in
                        self?.showToast(ToastMessage(style: .warning, title: "Not connected", detail: "Queued — will send when reconnected"))
                    }
                } else {
                    DiagnosticLog.log("user command dropped, no transport and not queueable", tag: "session.commands", level: .error, fields: [:])
                    Task { @MainActor [weak self] in
                        self?.showToast(ToastMessage(style: .error, title: "Not connected", detail: "Command could not be sent"))
                    }
                }
                return
            }
            Task { [weak self] in
                do {
                    try await transport.send(command)
                } catch {
                    // Send failed or timed out (wedged socket, mid-reconnect).
                    // Re-enqueue queueable commands for the reconnect flush so
                    // the user's action still lands; surface a visible error
                    // for commands that cannot be retried safely.
                    guard let self else { return }
                    let detail = error.localizedDescription
                    if let key = command.essentialKey {
                        DiagnosticLog.log("user command send failed, requeued for reconnect flush", tag: "session.commands", level: .warn, fields: [
                            "reason": key,
                            "error": detail
                        ])
                        await MainActor.run {
                            self.enqueueEssential(key: key, command: command)
                            self.showToast(ToastMessage(style: .warning, title: "Connection interrupted", detail: "Queued — will send when reconnected"))
                        }
                    } else {
                        DiagnosticLog.log("user command send failed, not queueable", tag: "session.commands", level: .error, fields: [
                            "error": detail
                        ])
                        await MainActor.run {
                            self.showToast(ToastMessage(style: .error, title: "Send failed", detail: detail))
                        }
                    }
                }
            }

        case .automaticEssential:
            // Defer to the essential queue when EITHER the connection state
            // is not `.connected` OR the transport object is nil. The two can
            // disagree: during a soft-reconnect teardown the transport is torn
            // down (nil) while `connectionState` still reads `.connected`
            // until the next state flip. Both conditions mean "cannot send
            // right now" and both take the same deferral path — nothing is
            // dropped. The log carries both facts so the deferral reason is
            // unambiguous (previously it logged "not connected" even when the
            // status field said "connected" and the real cause was a nil
            // transport).
            guard connectionState == .connected, let transport else {
                let key = command.essentialKey ?? "unknown:\(command)"
                DiagnosticLog.log("essential deferred (transport unavailable)", tag: "session.commands", fields: [
                    "reason": key,
                    "status": connectionState.rawValue,
                    "transport": transport == nil ? "nil" : "present"
                ])
                enqueueEssential(key: key, command: command)
                return
            }
            Task { [weak self] in
                do {
                    try await transport.send(command)
                } catch {
                    // Connected-but-threw means the transport wedged between
                    // the state check and the write. Re-enqueue so the command
                    // delivers on the reconnect flush (the failed send tears
                    // the transport down, which drives reconnect -> sync ->
                    // snapshot -> drain) instead of being lost.
                    guard let self else { return }
                    let key = command.essentialKey ?? "unknown:\(command)"
                    DiagnosticLog.log("essential send failed, requeued for reconnect flush", tag: "session.commands", level: .warn, fields: [
                        "reason": key,
                        "error": error.localizedDescription
                    ])
                    await MainActor.run {
                        self.enqueueEssential(key: key, command: command)
                    }
                }
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

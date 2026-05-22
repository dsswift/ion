import SwiftUI

struct ConversationView: View {
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.dismiss) private var dismiss
    let tabId: String

    @State private var cachedRestoredCard: PermissionRequest?
    @State private var isNearBottom: Bool = true
    @State private var forceScrollCounter: Int = 0
    @State private var showGitPane = false
    @State private var showFileExplorer = false
    @State private var showTerminal = false
    @State private var showAttachments = false
    /// Set to true when a reconnect-triggered reload is in flight so the next
    /// `messageCountByTab` change force-scrolls to the bottom regardless of
    /// whether the last message is from the user.
    @State private var pendingScrollAfterReload = false

    private var tab: RemoteTabState? {
        viewModel.tab(for: tabId)
    }

    private var isRunning: Bool {
        tab?.status == .running || tab?.status == .connecting
    }

    private var conversationMessages: [Message] {
        viewModel.messages[tabId] ?? []
    }

    private var attachmentCount: Int {
        countConversationAttachments(conversationMessages, desktopCache: viewModel.tabAttachmentCache[tabId])
    }

    private var groupedItems: [ConversationItem] {
        groupConversationItems(conversationMessages)
    }

    private var isLoading: Bool {
        viewModel.loadingConversation.contains(tabId)
    }

    private var loadFailed: Bool {
        viewModel.conversationLoadFailed.contains(tabId)
    }

    /// Derives a human-readable activity string from current state,
    /// mirroring the desktop's `tab.currentActivity` ("Thinking…", etc.).
    private var currentActivity: String {
        // 1. Active tools → "Running {toolName}…"
        if let tools = viewModel.activeTools[tabId], !tools.isEmpty {
            if let first = tools.values.first {
                return "Running \(first.toolName)…"
            }
        }
        // 2. Last message is assistant and streaming → "Writing…"
        if let last = conversationMessages.last, last.role == .assistant {
            return "Writing…"
        }
        // 3. Default
        return "Thinking…"
    }

    /// True when the engine is actively compacting context.
    /// Detected from the last system message being a compacting marker,
    /// or from a snapshot that included compacting status.
    private var isCompacting: Bool {
        currentActivity.hasPrefix("Compacting")
    }

    private var pendingPermission: PermissionRequest? {
        if let queue = tab?.permissionQueue {
            // ExitPlanMode cards should only show when the tab is no longer running
            // (matches desktop where the card appears after task_complete).
            for request in queue {
                if request.toolName == "ExitPlanMode" {
                    if isRunning { continue }
                    // Snapshot queue entries lack planContent -- prefer restored card from enriched messages
                    if request.toolInput?["planContent"]?.value as? String == nil,
                       let restored = cachedRestoredCard,
                       restored.toolInput?["planContent"]?.value as? String != nil {
                        DiagnosticLog.log("PERM-CARD: pendingPermission: using restored ExitPlanMode card (queue entry lacks planContent)")
                        return restored
                    }
                }
                // AskUserQuestion from the queue is always live — the run stopped
                // specifically to wait for this answer. Status is 'completed' in
                // plan-mode because task_complete fired when the question was posed,
                // not when the user actually answered. Never skip it here.
                // Snapshot queue entries for AskUserQuestion may lack toolInput
                // (stale restored denials from older desktop builds). Prefer the
                // restored card synthesized from conversation history which has
                // the actual question text.
                if request.toolName == "AskUserQuestion" {
                    if request.toolInput == nil || request.toolInput?.isEmpty == true {
                        if let restored = cachedRestoredCard,
                           restored.toolName == "AskUserQuestion",
                           restored.toolInput?["question"]?.value as? String != nil {
                            DiagnosticLog.log("PERM-CARD: pendingPermission: using restored AskUserQuestion card (queue entry lacks toolInput)")
                            return restored
                        }
                    }
                }
                let inputKeys = request.toolInput?.keys.sorted() ?? []
                DiagnosticLog.log("PERM-CARD: pendingPermission: from queue — toolName=\(request.toolName) questionId=\(request.questionId) inputKeys=\(inputKeys)")
                return request
            }
        }
        // Synthesize a card from conversation history when the permission queue
        // is empty (e.g. reopening a previous conversation, or the live
        // permission_request arrived before task_complete set status=completed).
        // Allow idle, completed, and running (stuck-running recovery).
        //
        // Staleness rule for AskUserQuestion: only skip if a user message
        // appears AFTER the AskUserQuestion in the conversation — meaning the
        // user already answered it. status==completed is NOT sufficient to
        // declare it stale because task_complete fires when the question is
        // first posed (the run ends to await the answer).
        //
        // ExitPlanMode follows the same staleness rule; additionally it should
        // not surface while the tab is actively running (the card appears after
        // task_complete, not during).
        let currentStatus = tab?.status
        let queueEmpty = (tab?.permissionQueue ?? []).isEmpty
        let messagesLoaded = !conversationMessages.isEmpty

        if let status = currentStatus,
           (status == .idle || status == .completed || (status == .running && queueEmpty && messagesLoaded)),
           !viewModel.dismissedLiveSpecialTabs.contains(tabId),
           let restored = cachedRestoredCard,
           !viewModel.dismissedRestoredCards.contains(restored.questionId) {
            // ExitPlanMode: suppress while genuinely running — the plan card
            // should only appear once the run has stopped.
            if restored.toolName == "ExitPlanMode" && status == .running {
                DiagnosticLog.log("PERM-CARD: pendingPermission: suppressing ExitPlanMode while running")
            } else {
                let inputKeys = restored.toolInput?.keys.sorted() ?? []
                DiagnosticLog.log("PERM-CARD: pendingPermission: from restored card — toolName=\(restored.toolName) questionId=\(restored.questionId) inputKeys=\(inputKeys) status=\(status.rawValue)")
                return restored
            }
        }
        DiagnosticLog.log("PERM-CARD: pendingPermission: nil (queueSize=\(tab?.permissionQueue.count ?? -1) status=\(tab?.status.rawValue ?? "nil"))")
        return nil
    }

    /// Detect ExitPlanMode or AskUserQuestion as the last tool in history
    /// and synthesize a PermissionRequest so the card renders on reopen.
    /// Returns nil if a user message appears after the tool (the conversation
    /// has moved past the plan/question and the card is stale).
    private func computeRestoredSpecialCard() -> PermissionRequest? {
        guard let lastTool = conversationMessages.last(where: { $0.isTool }),
              lastTool.toolName == "ExitPlanMode" || lastTool.toolName == "AskUserQuestion"
        else {
            DiagnosticLog.log("PERM-CARD: computeRestoredSpecialCard: no ExitPlanMode/AskUserQuestion as last tool (totalMessages=\(conversationMessages.count))")
            return nil
        }

        DiagnosticLog.log("PERM-CARD: computeRestoredSpecialCard: found lastTool=\(lastTool.toolName ?? "nil") id=\(lastTool.id) toolInput=\(lastTool.toolInput?.prefix(200) ?? "nil")")

        // Stale detection: walk backwards from the end of the conversation.
        // If a user message appears before we hit the tool, the conversation
        // continued past this plan/question — don't resurface the card.
        for message in conversationMessages.reversed() {
            if message.id == lastTool.id { break } // hit the tool first — genuine
            if message.role == .user {
                DiagnosticLog.log("PERM-CARD: computeRestoredSpecialCard: stale — user message after tool")
                return nil
            }
        }

        var toolInput: [String: AnyCodable]?
        if let inputStr = lastTool.toolInput, let data = inputStr.data(using: .utf8),
           let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            toolInput = dict.mapValues { AnyCodable($0) }
            let keys = dict.keys.sorted()
            let typeSummary = dict.map { "\($0.key): \(type(of: $0.value))" }.joined(separator: ", ")
            DiagnosticLog.log("PERM-CARD: computeRestoredSpecialCard: parsed toolInput keys=\(keys) types=[\(typeSummary)]")
        } else {
            DiagnosticLog.log("PERM-CARD: computeRestoredSpecialCard: failed to parse toolInput string=\(lastTool.toolInput?.prefix(200) ?? "nil")")
        }

        let request = PermissionRequest(
            questionId: "restored-\(lastTool.id)",
            toolName: lastTool.toolName ?? "",
            toolInput: toolInput,
            options: []
        )
        DiagnosticLog.log("PERM-CARD: computeRestoredSpecialCard: synthesized request questionId=\(request.questionId) toolName=\(request.toolName) inputKeys=\(toolInput?.keys.sorted() ?? [])")
        return request
    }

    // MARK: - Row items for the collection view

    /// Unified row enum that wraps both state indicators and conversation items.
    /// Hashable by a stable string id for the diffable data source.
    private enum RowItem: Hashable {
        case loadMore
        case loading
        case loadFailed
        case empty
        case conversation(ConversationItem)
        case liveText(String)

        var stableId: String {
            switch self {
            case .loadMore: return "__loadMore"
            case .loading: return "__loading"
            case .loadFailed: return "__loadFailed"
            case .empty: return "__empty"
            case .conversation(let item): return item.id
            case .liveText: return "__liveText"
            }
        }

        static func == (lhs: Self, rhs: Self) -> Bool {
            lhs.stableId == rhs.stableId
        }
        func hash(into hasher: inout Hasher) {
            hasher.combine(stableId)
        }
    }

    private var rowItems: [ChatItem<RowItem>] {
        var result: [ChatItem<RowItem>] = []

        if viewModel.conversationHasMore[tabId] == true {
            result.append(ChatItem(id: "__loadMore", payload: .loadMore))
        }
        if isLoading && conversationMessages.isEmpty {
            result.append(ChatItem(id: "__loading", payload: .loading))
        } else if loadFailed && conversationMessages.isEmpty {
            result.append(ChatItem(id: "__loadFailed", payload: .loadFailed))
        }
        if conversationMessages.isEmpty && !isLoading && !loadFailed && (viewModel.tab(for: tabId)?.permissionQueue.isEmpty ?? true) {
            result.append(ChatItem(id: "__empty", payload: .empty))
        }
        for item in groupedItems {
            result.append(ChatItem(id: item.id, payload: .conversation(item)))
        }
        if conversationMessages.isEmpty,
           let text = viewModel.liveText[tabId], !text.isEmpty {
            result.append(ChatItem(id: "__liveText", payload: .liveText(text)))
        }
        return result
    }

    var body: some View {
        VStack(spacing: 0) {
            ZStack(alignment: .bottom) {
                messageList
                if !isNearBottom {
                    Button {
                        isNearBottom = true
                        forceScrollCounter += 1
                    } label: {
                        Image(systemName: "chevron.down")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(.secondary)
                            .frame(width: 40, height: 40)
                            .background(.regularMaterial)
                            .clipShape(Circle())
                            .shadow(color: .black.opacity(0.15), radius: 4, y: 2)
                    }
                    .padding(.bottom, 12)
                    .transition(.opacity.combined(with: .scale))
                }
            }
            .animation(IonTheme.snappySpring, value: isNearBottom)

            // Activity indicator — pinned above status bar, always visible
            if isRunning {
                ActivityIndicatorView(
                    text: currentActivity,
                    dotColorOverride: isCompacting ? .blue : nil
                )
            }

            // Voice playback bar — always visible when speaking
            if viewModel.voiceService.isSpeaking {
                VoicePlaybackBar(
                    onSkip: { viewModel.voiceService.skip() },
                    onStopAll: { viewModel.voiceService.stop() },
                    hasPending: viewModel.voiceService.hasPending
                )
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            if let request = pendingPermission {
                PermissionCardView(tabId: tabId, request: request)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 8)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            ConversationStatusBar(
                modelOverride: tab?.modelOverride,
                preferredModel: viewModel.preferredModel,
                contextPercent: tab?.contextPercent,
                contextTokens: tab?.contextTokens,
                isRunning: isRunning,
                permissionMode: tab?.permissionMode,
                availableModels: viewModel.availableModels,
                attachmentCount: attachmentCount,
                onSelectModel: { model in
                    viewModel.setTabModel(tabId: tabId, model: model)
                },
                onToggleMode: {
                    guard let current = tab?.permissionMode else { return }
                    let newMode: PermissionMode = current == .plan ? .auto : .plan
                    viewModel.setPermissionMode(tabId: tabId, mode: newMode)
                },
                onTapAttachments: {
                    showAttachments = true
                }
            )

            // Queued prompts indicator
            if let queued = tab?.queuedPrompts, !queued.isEmpty {
                HStack(spacing: 6) {
                    Image(systemName: "clock")
                        .font(.caption)
                    Text("\(queued.count) queued prompt\(queued.count == 1 ? "" : "s")")
                        .font(.caption)
                }
                .foregroundStyle(.secondary)
                .padding(.horizontal, 12)
                .padding(.vertical, 4)
                .background(Capsule().fill(Color(.tertiarySystemFill)))
            }

            InputBar(tabId: tabId)
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Color(.systemBackground), for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Text(tab?.displayTitle ?? "Tab")
                    .font(.headline)
                    .lineLimit(1)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button { showFileExplorer = true } label: {
                        Label("File Explorer", systemImage: "folder")
                    }
                    Button { showGitPane = true } label: {
                        Label("Git", systemImage: "arrow.triangle.branch")
                    }
                    Button { showTerminal = true } label: {
                        Label("Terminal", systemImage: "terminal")
                    }
                } label: {
                    Image(systemName: "square.grid.2x2")
                        .font(.subheadline)
                }
            }
        }
        .task {
            viewModel.loadConversation(tabId: tabId)
            cachedRestoredCard = computeRestoredSpecialCard()
        }
        .onChange(of: viewModel.messageCountByTab[tabId]) {
            cachedRestoredCard = computeRestoredSpecialCard()

            guard !viewModel.suppressScrollToBottom else {
                viewModel.suppressScrollToBottom = false
                return
            }
            // If a reconnect-triggered reload just delivered fresh history,
            // force-scroll to the new bottom regardless of who sent the last
            // message. The user backgrounded the app; on return they expect
            // to see the latest state of the conversation.
            if pendingScrollAfterReload {
                pendingScrollAfterReload = false
                isNearBottom = true
                forceScrollCounter += 1
                return
            }
            // Always scroll to bottom when the user sends a message,
            // even if they were scrolled up — matches desktop behavior.
            let userSent = conversationMessages.last?.role == .user
            if userSent {
                isNearBottom = true
                forceScrollCounter += 1
            }
        }
        .onChange(of: viewModel.connectionState) { oldState, newState in
            if newState == .disconnected {
                dismiss()
            }
            // Re-sync the conversation when we recover from a transient
            // disconnect (e.g. the phone was locked while the conversation
            // continued on the desktop). The snapshot updates tab status,
            // but message_added/message_updated events emitted during the
            // disconnect window are lost — only an explicit reload pulls
            // the desktop's current truth (completed tools, new messages).
            if oldState == .reconnecting && newState == .connected {
                DiagnosticLog.log("RESUME-SYNC: ConversationView reloading tabId=\(tabId.prefix(8))")
                pendingScrollAfterReload = true
                viewModel.loadConversation(tabId: tabId)
            }
        }
        .onChange(of: viewModel.tabIds) { _, newIds in
            // Tab was closed on the desktop -- auto-dismiss
            if !newIds.contains(tabId) {
                dismiss()
            }
        }
        .animation(.default, value: pendingPermission?.id)
        .task {
            // Present git pane if navigated here via the branch badge tap
            if viewModel.pendingGitPaneTabId == tabId {
                viewModel.pendingGitPaneTabId = nil
                showGitPane = true
            }
        }
        .onChange(of: viewModel.pendingGitPaneTabId) { _, newId in
            if newId == tabId {
                viewModel.pendingGitPaneTabId = nil
                showGitPane = true
            }
        }
        .fullScreenCover(isPresented: $showGitPane) {
            GitPaneView(tabId: tabId)
                .environment(viewModel)
        }
        .fullScreenCover(isPresented: $showFileExplorer) {
            FileExplorerView(tabId: tabId)
                .environment(viewModel)
        }
        .fullScreenCover(isPresented: $showTerminal) {
            ConversationTerminalView(tabId: tabId)
                .environment(viewModel)
        }
        .sheet(isPresented: $showAttachments) {
            ConversationAttachmentsSheet(tabId: tabId)
                .environment(viewModel)
        }
    }

    // MARK: - Message List

    private var messageList: some View {
        ChatCollectionView(
            items: rowItems,
            isNearBottom: $isNearBottom,
            forceScrollCounter: forceScrollCounter,
            spacing: 6,
            horizontalInset: 0
        ) { [self] rowItem in
            rowView(rowItem)
        }
    }

    // MARK: - Row dispatch

    @ViewBuilder
    private func rowView(_ rowItem: RowItem) -> some View {
        switch rowItem {
        case .loadMore:
            Button {
                viewModel.loadMoreMessages(tabId: tabId)
            } label: {
                if isLoading {
                    ProgressView()
                } else {
                    Text("Load earlier messages")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 8)

        case .loading:
            ProgressView("Loading conversation...")
                .padding(.top, 40)

        case .loadFailed:
            Button {
                viewModel.loadConversation(tabId: tabId)
            } label: {
                VStack(spacing: 8) {
                    Image(systemName: "arrow.clockwise")
                        .font(.title2)
                    Text("Couldn't load conversation.\nTap to retry.")
                        .font(.subheadline)
                        .multilineTextAlignment(.center)
                        .foregroundStyle(.secondary)
                }
            }
            .buttonStyle(.plain)
            .padding(.top, 40)

        case .empty:
            VStack(spacing: 12) {
                Image("IonIcon")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 48, height: 48)
                    .foregroundStyle(.tertiary)
                Text("Send a message to get started")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 80)

        case .conversation(let item):
            conversationItemView(item)

        case .liveText(let text):
            Text(text)
                .font(.system(.body, design: .monospaced))
                .textSelection(.enabled)
                .padding(.horizontal)
        }
    }

    // MARK: - Conversation item dispatch

    @ViewBuilder
    private func conversationItemView(_ item: ConversationItem) -> some View {
        switch item {
        case .user(let message):
            MessageBubble(
                message: message,
                isRunning: false,
                onRewind: { messageId in
                    viewModel.rewindConversation(tabId: tabId, messageId: messageId)
                },
                onFork: { messageId in
                    viewModel.forkFromMessage(tabId: tabId, messageId: messageId)
                }
            )

        case .assistant(let message):
            let isLast = message.id == conversationMessages.last?.id
            let combined = consecutiveAssistantContent(
                for: message.id, in: conversationMessages
            )
            let voiceSvc = viewModel.voiceService
            MessageBubble(
                message: message,
                isRunning: isRunning && isLast,
                copyableContent: combined,
                isSpeaking: voiceSvc.speakingMessageId == message.id && voiceSvc.isSpeaking,
                hasPendingSpeech: voiceSvc.hasPending,
                onSkipSpeaking: { voiceSvc.skip() },
                onStopAllSpeaking: { voiceSvc.stop() }
            )

        case .system(let message):
            MessageBubble(message: message)

        case .toolGroup(let tools):
            ToolGroupView(tools: tools, isTabRunning: isRunning)

        case .compaction(let message):
            CompactionRowView(message: message)
        }
    }
}

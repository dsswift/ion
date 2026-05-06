import SwiftUI

struct ConversationView: View {
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.dismiss) private var dismiss
    let tabId: String

    @State private var cachedRestoredCard: PermissionRequest?
    @State private var scrollTask: Task<Void, Never>?
    @State private var scrollProxy: ScrollViewProxy?
    @State private var showGitPane = false
    @State private var showFileExplorer = false

    private var tab: RemoteTabState? {
        viewModel.tab(for: tabId)
    }

    private var isRunning: Bool {
        tab?.status == .running || tab?.status == .connecting
    }

    private var conversationMessages: [Message] {
        viewModel.messages[tabId] ?? []
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
                        return restored
                    }
                }
                return request
            }
        }
        // Synthesize a card from conversation history when the permission queue
        // is empty (e.g. reopening a previous conversation). Also allow completed
        // status so the card survives the task_complete → permission_request gap.
        if let status = tab?.status, (status == .idle || status == .completed),
           !viewModel.dismissedLiveSpecialTabs.contains(tabId),
           let restored = cachedRestoredCard,
           !viewModel.dismissedRestoredCards.contains(restored.questionId) {
            return restored
        }
        return nil
    }

    /// Detect ExitPlanMode or AskUserQuestion as the last tool in history
    /// and synthesize a PermissionRequest so the card renders on reopen.
    /// Returns nil if a user message appears after the tool (the conversation
    /// has moved past the plan/question and the card is stale).
    private func computeRestoredSpecialCard() -> PermissionRequest? {
        guard let lastTool = conversationMessages.last(where: { $0.isTool }),
              lastTool.toolName == "ExitPlanMode" || lastTool.toolName == "AskUserQuestion"
        else { return nil }

        // Stale detection: walk backwards from the end of the conversation.
        // If a user message appears before we hit the tool, the conversation
        // continued past this plan/question — don't resurface the card.
        for message in conversationMessages.reversed() {
            if message.id == lastTool.id { break } // hit the tool first — genuine
            if message.role == .user { return nil } // user spoke after — stale
        }

        var toolInput: [String: AnyCodable]?
        if let inputStr = lastTool.toolInput, let data = inputStr.data(using: .utf8),
           let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            toolInput = dict.mapValues { AnyCodable($0) }
        }
        return PermissionRequest(
            questionId: "restored-\(lastTool.id)",
            toolName: lastTool.toolName ?? "",
            toolInput: toolInput,
            options: []
        )
    }

    var body: some View {
        VStack(spacing: 0) {
            messageList

            // Activity indicator — pinned above input, always visible
            if isRunning {
                ActivityIndicatorView(text: currentActivity)
            }

            if let request = pendingPermission {
                PermissionCardView(tabId: tabId, request: request)
                    .padding()
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            // Queued prompts indicator
            if let queued = tab?.queuedPrompts, !queued.isEmpty {
                HStack(spacing: 6) {
                    Image(systemName: "clock")
                        .font(.caption)
                    Text("\(queued.count) queued prompt\(queued.count == 1 ? "" : "s")")
                        .font(.caption)
                }
                .foregroundStyle(.secondary)
                .padding(.vertical, 4)
            }

            InputBar(tabId: tabId)
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Color(.systemBackground), for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .principal) {
                VStack(spacing: 0) {
                    Text(tab?.displayTitle ?? "Tab")
                        .font(.headline)
                    if let dir = tab?.workingDirectory {
                        Text((dir as NSString).lastPathComponent)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    if let status = tab?.status {
                        Text(status.rawValue.capitalized)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                HStack(spacing: 12) {
                    Button {
                        showFileExplorer = true
                    } label: {
                        Image(systemName: "folder")
                            .font(.subheadline)
                    }

                    Button {
                        showGitPane = true
                    } label: {
                        Image(systemName: "arrow.triangle.branch")
                            .font(.subheadline)
                    }

                    Button {
                        guard let current = tab?.permissionMode else { return }
                        let newMode: PermissionMode = current == .plan ? .auto : .plan
                        viewModel.setPermissionMode(tabId: tabId, mode: newMode)
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: tab?.permissionMode == .plan ? "doc.text" : "bolt.fill")
                                .font(.caption)
                            Text(tab?.permissionMode == .plan ? "Plan" : "Auto")
                                .font(.caption.weight(.medium))
                        }
                        .foregroundStyle(tab?.permissionMode == .plan ? Color(hex: 0x2EB8A6) : .secondary)
                    }
                }
            }
        }
        .onAppear {
            viewModel.loadConversation(tabId: tabId)
            cachedRestoredCard = computeRestoredSpecialCard()
        }
        .onDisappear {
            scrollTask?.cancel()
            viewModel.clearConversation(tabId: tabId)
        }
        .onChange(of: viewModel.messageCountByTab[tabId]) {
            cachedRestoredCard = computeRestoredSpecialCard()
            guard !viewModel.suppressScrollToBottom else {
                viewModel.suppressScrollToBottom = false
                return
            }
            // Defer scroll to let LazyVStack finish layout
            scrollTask?.cancel()
            scrollTask = Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(50))
                guard !Task.isCancelled else { return }
                if let proxy = scrollProxy {
                    withAnimation {
                        proxy.scrollTo("bottom", anchor: .bottom)
                    }
                }
            }
        }
        .onChange(of: viewModel.connectionState) { _, newState in
            if newState == .disconnected {
                dismiss()
            }
        }
        .onChange(of: viewModel.tabIds) { _, newIds in
            // Tab was closed on the desktop -- auto-dismiss
            if !newIds.contains(tabId) {
                dismiss()
            }
        }
        .animation(.default, value: pendingPermission?.id)
        .fullScreenCover(isPresented: $showGitPane) {
            GitPaneView(tabId: tabId)
                .environment(viewModel)
        }
        .fullScreenCover(isPresented: $showFileExplorer) {
            FileExplorerView(tabId: tabId)
                .environment(viewModel)
        }
    }

    // MARK: - Message List

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 4) {
                    // "Load more" button at the top
                    if viewModel.conversationHasMore[tabId] == true {
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
                    }

                    // Loading indicator for initial load
                    if isLoading && conversationMessages.isEmpty {
                        ProgressView("Loading conversation...")
                            .padding(.top, 40)
                    } else if loadFailed && conversationMessages.isEmpty {
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
                    }

                    // Messages (grouped)
                    ForEach(groupedItems) { item in
                        conversationItemView(item)
                    }

                    // Fallback: legacy liveText when no structured messages
                    if conversationMessages.isEmpty, let text = viewModel.liveText[tabId], !text.isEmpty {
                        Text(text)
                            .font(.system(.body, design: .monospaced))
                            .textSelection(.enabled)
                            .padding(.horizontal)
                    }

                    Color.clear
                        .frame(height: 1)
                        .id("bottom")
                }
                .padding(.vertical)
            }
            .onAppear { scrollProxy = proxy }
        }
    }

    // MARK: - Item dispatch

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
            .id(message.id)

        case .assistant(let message):
            let isLast = message.id == conversationMessages.last?.id
            MessageBubble(
                message: message,
                isRunning: isRunning && isLast
            )
            .id(message.id)

        case .system(let message):
            MessageBubble(message: message)
                .id(message.id)

        case .toolGroup(let tools):
            ToolGroupView(tools: tools, isTabRunning: isRunning)
                .id(item.id)
        }
    }
}

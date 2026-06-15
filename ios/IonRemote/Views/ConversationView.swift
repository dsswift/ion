import SwiftUI

struct ConversationView: View {
    @Environment(SessionViewModel.self) var viewModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.appTheme) private var theme
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

    var isRunning: Bool {
        tab?.status == .running || tab?.status == .connecting
    }

    var conversationMessages: [Message] {
        viewModel.messages[tabId] ?? []
    }

    private var attachmentCount: Int {
        guard let cache = viewModel.tabAttachmentCache[tabId] else { return 0 }
        return cache.count
    }

    private var unifiedTurnView: Bool {
        if let settings = viewModel.desktopSettings,
           let val = settings.currentValue(for: "unifiedTurnView"),
           let flag = val.value as? Bool {
            return flag
        }
        return true
    }

    private var groupedItems: [ConversationItem] {
        groupConversationItems(conversationMessages, unifiedTurnView: unifiedTurnView)
    }

    var isLoading: Bool {
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
    /// Returns nil when the card has been dismissed — either a user message or
    /// a `/clear` divider appears after the tool. The dismissal rule lives in
    /// `PendingCard.outcome` (a pure, unit-tested function mirrored from the
    /// desktop's shared pending-card rule) so both clients agree exactly.
    private func computeRestoredSpecialCard() -> PermissionRequest? {
        let outcome = PendingCard.outcome(for: conversationMessages)
        let lastTool: Message
        switch outcome {
        case .none:
            DiagnosticLog.log("PERM-CARD: computeRestoredSpecialCard: no ExitPlanMode/AskUserQuestion as last outstanding tool (totalMessages=\(conversationMessages.count))")
            return nil
        case .suppressedByUser:
            DiagnosticLog.log("PERM-CARD: computeRestoredSpecialCard: stale — user message after tool")
            return nil
        case .suppressedByClear:
            DiagnosticLog.log("PERM-CARD: computeRestoredSpecialCard: suppressed — /clear divider after tool")
            return nil
        case .found(let tool):
            lastTool = tool
        }

        DiagnosticLog.log("PERM-CARD: computeRestoredSpecialCard: found lastTool=\(lastTool.toolName ?? "nil") id=\(lastTool.id) toolInput=\(lastTool.toolInput?.prefix(200) ?? "nil")")

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
    enum RowItem: Hashable {
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

    private var themedBackground: some View {
        ZStack {
            theme.background.ignoresSafeArea()
            if let bg = theme.backgroundView {
                bg.ignoresSafeArea().opacity(0.35)
            }
        }
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
                engineContextWindow: tab?.contextWindow,
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
        .background(themedBackground)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(theme.background.opacity(0.95), for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbarColorScheme(theme.backgroundView != nil ? .dark : nil, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .principal) {
                if theme.backgroundView != nil {
                    Text(tab?.displayTitle ?? "Tab")
                        .font(.headline.bold())
                        .foregroundStyle(theme.accent)
                        .shadow(color: theme.accent.opacity(0.8), radius: 4)
                        .shadow(color: theme.accent.opacity(0.4), radius: 10)
                } else {
                    Text(tab?.displayTitle ?? "Tab")
                        .font(.headline)
                        .lineLimit(1)
                }
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
                        .foregroundStyle(theme.accent)
                }
            }
        }
        .task {
            DiagnosticLog.log("ATTACH: ConversationView.task tabId=\(tabId.prefix(8)) cacheBeforeRequest=\(viewModel.tabAttachmentCache[tabId]?.count ?? -1)")
            viewModel.loadConversation(tabId: tabId)
            viewModel.requestLoadAttachments(tabId: tabId)
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
                viewModel.requestLoadAttachments(tabId: tabId)
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
        // Share-sheet presentation for /export payloads. The view-model
        // parks the rendered output on `pendingExport` whenever the
        // engine_export event arrives; we present the system share
        // sheet, then clear the field once the user dismisses it. The
        // tabId match guards against a stale export from a different
        // tab firing on this view (only one share sheet at a time, and
        // SwiftUI gates re-presentation on the `id` change).
        //
        // We share a temp-file URL (not the bare string) so AirDrop /
        // Files / Mail receive a correctly-typed, correctly-named
        // artifact. The extension comes from the engine-reported
        // export format. If the temp-file write fails we fall back to
        // sharing the raw string so the user is never left with a
        // broken share sheet.
        .sheet(item: Binding(
            get: { viewModel.pendingExport?.tabId == tabId ? viewModel.pendingExport : nil },
            set: { _ in viewModel.pendingExport = nil }
        )) { export in
            ExportShareSheet(items: ConversationView.shareItems(for: export))
        }
    }

    /// Build the share-sheet item array for an export. Prefers a typed
    /// temp-file URL (`ion-conversation-<date>.<ext>`) written from the
    /// payload so the system share sheet shows a real file; falls back
    /// to the raw payload string if the write fails.
    static func shareItems(for export: PendingExport) -> [Any] {
        let ext = ConversationView.fileExtension(for: export.format)
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withFullDate]
        let date = iso.string(from: Date())
        let suffix = String(UUID().uuidString.prefix(6)).lowercased()
        let name = "ion-conversation-\(date)-\(suffix).\(ext)"
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        do {
            try export.payload.write(to: url, atomically: true, encoding: .utf8)
            return [url]
        } catch {
            // Temp-file write failed (rare — sandbox/disk pressure). Share
            // the raw string so the user still gets a usable share sheet.
            return [export.payload]
        }
    }

    /// Map the engine-reported export format to a file extension. Mirrors
    /// the desktop's extensionForFormat; nil/unrecognized defaults to the
    /// engine's own /export default (markdown → md).
    static func fileExtension(for format: String?) -> String {
        switch format {
        case "markdown": return "md"
        case "json": return "json"
        case "html": return "html"
        case "jsonl": return "jsonl"
        default: return "md"
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
}

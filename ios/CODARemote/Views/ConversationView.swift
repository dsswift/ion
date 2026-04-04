import SwiftUI

struct ConversationView: View {
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.dismiss) private var dismiss
    let tabId: String

    @State private var cachedRestoredCard: PermissionRequest?
    @State private var scrollTask: Task<Void, Never>?
    @State private var scrollProxy: ScrollViewProxy?

    private var tab: RemoteTabState? {
        viewModel.tab(for: tabId)
    }

    private var isRunning: Bool {
        tab?.status == .running
    }

    private var conversationMessages: [Message] {
        viewModel.messages[tabId] ?? []
    }

    private var isLoading: Bool {
        viewModel.loadingConversation.contains(tabId)
    }

    private var loadFailed: Bool {
        viewModel.conversationLoadFailed.contains(tabId)
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
        // is empty (e.g. reopening a previous conversation). Only when idle --
        // completed/failed/dead conversations should not resurface old cards.
        if tab?.status == .idle, !viewModel.dismissedLiveSpecialTabs.contains(tabId),
           let restored = cachedRestoredCard,
           !viewModel.dismissedRestoredCards.contains(restored.questionId) {
            return restored
        }
        return nil
    }

    /// Detect ExitPlanMode or AskUserQuestion as the last tool in history
    /// and synthesize a PermissionRequest so the card renders on reopen.
    private func computeRestoredSpecialCard() -> PermissionRequest? {
        guard let lastTool = conversationMessages.last(where: { $0.isTool }),
              lastTool.toolName == "ExitPlanMode" || lastTool.toolName == "AskUserQuestion"
        else { return nil }
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

                    // Messages
                    ForEach(conversationMessages) { message in
                        MessageBubble(
                            message: message,
                            isRunning: isRunning && message.id == conversationMessages.last?.id,
                            onRewind: message.role == .user ? { messageId in
                                viewModel.rewindConversation(tabId: tabId, messageId: messageId)
                            } : nil,
                            onFork: message.role == .user ? { messageId in
                                viewModel.forkFromMessage(tabId: tabId, messageId: messageId)
                            } : nil
                        )
                        .id(message.id)
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
}

// MARK: - MessageBubble

struct MessageBubble: View {
    let message: Message
    var isRunning: Bool = false
    var onRewind: ((String) -> Void)?
    var onFork: ((String) -> Void)?

    @State private var isToolExpanded = false
    @State private var showRewindConfirm = false

    var body: some View {
        switch message.role {
        case .user:
            userBubble
        case .assistant:
            assistantBubble
        case .tool:
            toolBubble
        case .system:
            systemBubble
        }
    }

    // MARK: - User

    private var userBubble: some View {
        HStack {
            Spacer(minLength: 24)
            VStack(alignment: .trailing, spacing: 4) {
                if let source = message.source, source == .remote {
                    HStack(spacing: 4) {
                        Image(systemName: "iphone")
                            .font(.caption2)
                        Text("from iOS")
                            .font(.caption2)
                    }
                    .foregroundStyle(.secondary)
                }
                Text(message.content)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color(hex: 0x4ECDC4).opacity(0.15))
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            .padding(.trailing, 12)
            .padding(.vertical, 2)
        }
        .contextMenu {
            Button { UIPasteboard.general.string = message.content } label: {
                Label("Copy", systemImage: "doc.on.doc")
            }
            ShareLink(item: message.content) {
                Label("Share", systemImage: "square.and.arrow.up")
            }
            if onRewind != nil || onFork != nil {
                Divider()
            }
            if onRewind != nil {
                Button { showRewindConfirm = true } label: {
                    Label("Rewind to Here", systemImage: "arrow.counterclockwise")
                }
            }
            if let onFork {
                Button { onFork(message.id) } label: {
                    Label("Fork from Here", systemImage: "arrow.triangle.branch")
                }
            }
        }
        .confirmationDialog(
            "Rewind Conversation",
            isPresented: $showRewindConfirm,
            titleVisibility: .visible
        ) {
            Button("Rewind", role: .destructive) {
                onRewind?(message.id)
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This will reset the conversation to before this message. This cannot be undone.")
        }
    }

    // MARK: - Assistant

    private var assistantBubble: some View {
        VStack(alignment: .leading, spacing: 4) {
            if !message.content.isEmpty {
                if let attributed = MarkdownCache.shared.attributedString(for: message.content) {
                    Text(attributed)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                } else {
                    Text(message.content)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            // Blinking cursor for streaming
            if isRunning && message.isAssistant {
                RoundedRectangle(cornerRadius: 1)
                    .fill(Color.primary)
                    .frame(width: 8, height: 16)
                    .opacity(0.6)
                    .modifier(BlinkingModifier())
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemFill))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .padding(.horizontal, 12)
        .padding(.vertical, 2)
    }

    // MARK: - Tool

    private var toolBubble: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.2)) {
                    isToolExpanded.toggle()
                }
            } label: {
                HStack(spacing: 8) {
                    toolStatusIcon

                    Text(message.toolName ?? "Tool")
                        .font(.subheadline.monospaced())
                        .foregroundStyle(.primary)

                    Spacer()

                    Image(systemName: isToolExpanded ? "chevron.up" : "chevron.down")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
            }
            .buttonStyle(.plain)

            if isToolExpanded {
                VStack(alignment: .leading, spacing: 4) {
                    if let input = message.toolInput, !input.isEmpty {
                        Text("Input:")
                            .font(.caption.bold())
                            .foregroundStyle(.secondary)
                        Text(input)
                            .font(.caption.monospaced())
                            .textSelection(.enabled)
                            .lineLimit(10)
                    }
                    if !message.content.isEmpty {
                        Text(message.toolStatus == .error ? "Error:" : "Result:")
                            .font(.caption.bold())
                            .foregroundStyle(message.toolStatus == .error ? .red : .secondary)
                        Text(message.content)
                            .font(.caption.monospaced())
                            .textSelection(.enabled)
                            .lineLimit(20)
                            .foregroundStyle(message.toolStatus == .error ? .red : .primary)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .background(Color(.tertiarySystemFill))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .padding(.horizontal, 12)
        .padding(.vertical, 1)
    }

    private var toolStatusIcon: some View {
        Group {
            switch message.toolStatus {
            case .running:
                ProgressView()
                    .controlSize(.mini)
            case .completed:
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                    .font(.subheadline)
            case .error:
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(.red)
                    .font(.subheadline)
            case nil:
                Image(systemName: "gearshape")
                    .foregroundStyle(.secondary)
                    .font(.subheadline)
            }
        }
    }

    // MARK: - System

    private var systemBubble: some View {
        HStack {
            Spacer()
            Text(message.content)
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
    }
}

// MARK: - BlinkingModifier

struct BlinkingModifier: ViewModifier {
    @State private var isVisible = true

    func body(content: Content) -> some View {
        content
            .opacity(isVisible ? 1 : 0)
            .onAppear {
                withAnimation(.easeInOut(duration: 0.5).repeatForever(autoreverses: true)) {
                    isVisible = false
                }
            }
    }
}

// MARK: - Color hex init

extension Color {
    init(hex: UInt, opacity: Double = 1.0) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: opacity
        )
    }
}

// MARK: - MarkdownCache

/// Caches parsed AttributedStrings so markdown is only parsed once per unique
/// content string, not on every SwiftUI re-render.
@MainActor
final class MarkdownCache {
    static let shared = MarkdownCache()

    private let cache = NSCache<NSString, CacheEntry>()

    private class CacheEntry {
        let value: AttributedString
        init(_ value: AttributedString) { self.value = value }
    }

    init() {
        cache.countLimit = 200
    }

    func attributedString(for content: String) -> AttributedString? {
        let key = content as NSString
        if let entry = cache.object(forKey: key) {
            return entry.value
        }
        guard let result = try? AttributedString(
            markdown: content,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) else { return nil }
        cache.setObject(CacheEntry(result), forKey: key)
        return result
    }
}

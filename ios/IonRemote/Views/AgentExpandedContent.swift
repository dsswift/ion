import SwiftUI

/// Shared expanded content for an agent: model tag, dispatch pager,
/// dispatch task bubble, conversation history, and loading states.
/// Embedded by `AgentBarRow` (inline, height-capped) and
/// `AgentDetailFullScreenView` (full-screen, uncapped).
struct AgentExpandedContent: View {
    let agent: AgentStateUpdate
    let messages: [Message]?
    let convMessageCache: [String: [Message]]
    let isLoadingMessages: Bool
    let onLoadDispatch: ((String) -> Void)?
    let onPreloadDispatches: ((String) -> Void)?
    @Environment(\.appTheme) private var theme
    @State private var selectedDispatchIndex: Int?

    // MARK: - Computed

    private var activeDispatch: DispatchInfo? {
        guard agent.dispatches.count > 1 else { return nil }
        let idx = selectedDispatchIndex ?? agent.dispatches.count - 1
        guard idx >= 0 && idx < agent.dispatches.count else { return nil }
        return agent.dispatches[idx]
    }

    private var activeMessages: [Message]? {
        if let dispatch = activeDispatch {
            // A specific dispatch is selected via the pager. If it has a
            // conversationId, look up its messages; if not (still running /
            // no conversation yet), return nil so the UI shows "Working…"
            // instead of leaking another dispatch's conversation.
            guard !dispatch.conversationId.isEmpty else { return nil }
            let msgs = convMessageCache[dispatch.conversationId]
            // When multiple dispatches share a conversationId (the engine
            // reuses the same session), slice messages by the dispatch's
            // time window so each pager tab shows only its own work.
            if let msgs, sharesConversationId(dispatch) {
                return sliceMessages(msgs, for: dispatch)
            }
            return msgs
        }
        // Single dispatch (no pager) — use the first dispatch's conversation.
        if let convId = agent.dispatches.first?.conversationId, !convId.isEmpty {
            let msgs = convMessageCache[convId]
            if let msgs, let first = agent.dispatches.first, agent.dispatches.count > 1,
               sharesConversationId(first) {
                return sliceMessages(msgs, for: first)
            }
            return msgs
        }
        return messages
    }

    /// Whether a dispatch shares its conversationId with any other dispatch.
    private func sharesConversationId(_ dispatch: DispatchInfo) -> Bool {
        guard !dispatch.conversationId.isEmpty else { return false }
        return agent.dispatches.contains { $0.id != dispatch.id && $0.conversationId == dispatch.conversationId }
    }

    /// Slices messages from a shared conversation to only those belonging to
    /// a specific dispatch, using the dispatch startTime as a boundary.
    /// Messages with timestamps ≥ this dispatch's start and < the next
    /// dispatch's start are included. Dispatch startTime is in seconds;
    /// message timestamps are in milliseconds.
    private func sliceMessages(_ msgs: [Message], for dispatch: DispatchInfo) -> [Message] {
        guard let startSec = dispatch.startTime else { return msgs }
        let startMs = startSec * 1000

        let siblings = agent.dispatches
            .filter { $0.conversationId == dispatch.conversationId }
            .sorted { ($0.startTime ?? 0) < ($1.startTime ?? 0) }
        let nextStart: Double? = siblings
            .first { ($0.startTime ?? 0) > startSec }
            .flatMap { $0.startTime.map { $0 * 1000 } }

        return msgs.filter { msg in
            guard let ts = msg.timestamp else { return true }
            if ts < startMs { return false }
            if let end = nextStart, ts >= end { return false }
            return true
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Model tag
            let activeModel = activeDispatch?.model ?? agent.model
            if let model = activeModel, !model.isEmpty {
                HStack(spacing: 4) {
                    Image(systemName: "cpu")
                        .font(.caption2)
                    Text(modelLabel(model))
                        .font(.caption2)
                }
                .foregroundStyle(theme.textSecondary.opacity(0.5))
                .padding(.horizontal, 12)
            }

            // Dispatch picker (shown when multiple dispatches exist)
            if agent.dispatches.count > 1 {
                dispatchPicker
            }

            // Dispatch task (the orchestrator's instruction to the agent)
            let activeTask = activeDispatch?.task ?? agent.task
            if let task = activeTask, !task.isEmpty {
                dispatchBubble(task)
            }

            // Agent conversation history (loaded on expand).
            // When loaded, replaces fullOutput (matches desktop behavior).
            // Skips user messages whose content matches the dispatch task
            // already shown in the bubble above.
            if let msgs = activeMessages, !msgs.isEmpty {
                ForEach(conversationMessages(msgs)) { msg in
                    conversationBubble(msg)
                }
            } else if isLoadingMessages {
                HStack(spacing: 6) {
                    ProgressView().scaleEffect(0.6)
                    Text("Loading conversation…")
                        .font(.caption2)
                        .foregroundStyle(theme.textSecondary.opacity(0.5))
                }
                .padding(.horizontal, 12)
            } else if activeDispatch == nil,
                      let fullOutput = agent.fullOutput, !fullOutput.isEmpty {
                // Fallback: show fullOutput only when no conversation loaded
                // and no specific dispatch is selected. In multi-dispatch mode
                // fullOutput is the agent's global output — not scoped to the
                // selected dispatch — so showing it would leak previous
                // dispatch content into a new dispatch that hasn't responded yet.
                MarkdownContentView(
                    blocks: MarkdownBlockCache.shared.blocks(for: fullOutput)
                )
                .textSelection(.enabled)
                .padding(.horizontal, 12)
            } else if agent.status == "running" || activeDispatch?.status == "running" {
                HStack(spacing: 6) {
                    ProgressView().scaleEffect(0.6)
                    Text("Working…")
                        .font(.caption2)
                        .foregroundStyle(theme.textSecondary.opacity(0.5))
                }
                .padding(.horizontal, 12)
            }
        }
        .padding(.vertical, 6)
    }

    // MARK: - Dispatch picker

    private var dispatchPicker: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                Text("Dispatches:")
                    .font(.system(size: 9))
                    .foregroundStyle(theme.textSecondary.opacity(0.5))
                ForEach(Array(agent.dispatches.enumerated().reversed()), id: \.element.id) { idx, d in
                    let displayNum = idx + 1
                    let isActive = idx == (selectedDispatchIndex ?? agent.dispatches.count - 1)
                    Button {
                        selectedDispatchIndex = idx
                        if !d.conversationId.isEmpty {
                            onLoadDispatch?(d.conversationId)
                        }
                    } label: {
                        Text("#\(displayNum)")
                            .font(.system(size: 10, weight: isActive ? .semibold : .regular))
                            .foregroundStyle(isActive ? theme.textPrimary : theme.textSecondary.opacity(0.5))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(isActive ? theme.surfaceElevated.opacity(0.7) : theme.surfaceElevated.opacity(0.3))
                            .clipShape(RoundedRectangle(cornerRadius: 4))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 12)
        }
    }

    // MARK: - Dispatch bubble

    private func dispatchBubble(_ task: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: "arrow.right.circle.fill")
                .font(.caption)
                .foregroundStyle(theme.accent.opacity(0.7))
                .padding(.top, 2)
            Text(task)
                .font(.caption2)
                .foregroundStyle(theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.accent.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .padding(.horizontal, 10)
    }

    // MARK: - Conversation rendering

    private func conversationMessages(_ msgs: [Message]) -> [Message] {
        let task = activeDispatch?.task ?? agent.task ?? ""
        return msgs.filter { msg in
            guard msg.role == .assistant || msg.role == .user else { return false }
            if msg.role == .user && !task.isEmpty && msg.content.trimmingCharacters(in: .whitespacesAndNewlines) == task.trimmingCharacters(in: .whitespacesAndNewlines) {
                return false
            }
            return !msg.content.isEmpty
        }
    }

    @ViewBuilder
    private func conversationBubble(_ msg: Message) -> some View {
        if msg.role == .user {
            HStack(alignment: .top, spacing: 6) {
                Image(systemName: "person.fill")
                    .font(.caption2)
                    .foregroundStyle(theme.textSecondary)
                    .padding(.top, 2)
                Text(msg.content)
                    .font(.caption2)
                    .foregroundStyle(theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(theme.surfaceElevated.opacity(0.5))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .padding(.horizontal, 10)
        } else {
            MarkdownContentView(
                blocks: MarkdownBlockCache.shared.blocks(for: msg.content)
            )
            .textSelection(.enabled)
            .padding(.horizontal, 12)
        }
    }

    // MARK: - Helpers

    private func modelLabel(_ model: String) -> String {
        if model.contains("opus") { return "Opus" }
        if model.contains("sonnet") { return "Sonnet" }
        if model.contains("haiku") { return "Haiku" }
        return model
    }
}

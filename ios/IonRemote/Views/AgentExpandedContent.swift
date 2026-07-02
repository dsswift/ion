import SwiftUI

/// Shared expanded content for an agent: model tag, dispatch pager,
/// conversation history, and loading states.
/// Embedded by `AgentBarRow` (inline, height-capped) and
/// `AgentDetailFullScreenView` (full-screen, uncapped).
///
/// When `pinHeader` is true (full-screen popup only), the view renders
/// a `VStack { headerView; ScrollView { bodyView } }` so the header
/// stays pinned above a scrolling transcript. When false (default), the
/// entire content is in a single VStack so the caller's ScrollView wraps it
/// all — keeping the inline AgentBarRow expand unchanged.
struct AgentExpandedContent: View {
    let agent: AgentStateUpdate
    let messages: [Message]?
    let convMessageCache: [String: [Message]]
    let isLoadingMessages: Bool
    let onLoadDispatch: ((String) -> Void)?
    let onPreloadDispatches: ((String) -> Void)?
    /// When true, the view renders its header above a self-managed
    /// ScrollView so the header stays pinned. Set only by
    /// AgentDetailFullScreenView. AgentBarRow leaves this false.
    var pinHeader: Bool = false
    /// Child agents dispatched by THIS agent (telemetry-derived), shown in the
    /// embedded agent panel of the dispatch preview. Only the pinned (popup)
    /// layout renders them; AgentBarRow leaves this nil. When pinHeader is true
    /// the embedded panel is always shown (even with zero children) so the
    /// preview always carries the panel — see Transcript.alwaysShowAgentPanel.
    var childAgents: [AgentStateUpdate]?
    /// Drill-down handler: opening a child agent row pushes onto the preview's
    /// breadcrumb navigation. nil in the inline AgentBarRow layout.
    var onOpenChildDispatch: ((DispatchInfo, AgentStateUpdate) -> Void)?
    @Environment(\.appTheme) private var theme
    @State private var selectedDispatchIndex: Int?
    /// Live clock for the duration ticker — only ticks when pinHeader is true
    /// and the agent is running, to avoid a needless timer in every inline row.
    @State private var now = Date()
    @State private var transcriptNearBottom = true
    @State private var transcriptForceScroll = 0

    // MARK: - Computed

    private var activeDispatch: DispatchInfo? {
        guard agent.dispatches.count > 1 else { return nil }
        let idx = selectedDispatchIndex ?? agent.dispatches.count - 1
        guard idx >= 0 && idx < agent.dispatches.count else { return nil }
        return agent.dispatches[idx]
    }

    /// Whether the "Working…" spinner should show for the current selection.
    /// When a specific dispatch is selected (pager / multi-dispatch), it is gated
    /// strictly on that dispatch's own status — never the live agent's — so a
    /// non-running dispatch never borrows a sibling's running state. In the
    /// single-dispatch case (no pager), fall back to the agent's status.
    private var dispatchIsRunning: Bool {
        DispatchBodyState.isRunning(
            hasActiveDispatch: activeDispatch != nil,
            dispatchStatus: activeDispatch?.status,
            agentStatus: agent.status
        )
    }

    private var activeMessages: [Message]? {
        if let dispatch = activeDispatch {
            // A specific dispatch is selected via the pager. If it has a
            // conversationId, look up its messages; if not (still running /
            // no conversation yet), return nil so the UI shows "Working…"
            // instead of leaking another dispatch's conversation.
            guard !dispatch.conversationId.isEmpty else { return nil }
            return convMessageCache[dispatch.conversationId]
        }
        // Single dispatch (no pager) — use the first dispatch's conversation.
        if let convId = agent.dispatches.first?.conversationId, !convId.isEmpty {
            return convMessageCache[convId]
        }
        return messages
    }

    // MARK: - Body

    var body: some View {
        if pinHeader {
            // Pinned layout: header outside the Transcript, transcript inside.
            VStack(alignment: .leading, spacing: 0) {
                headerView
                let msgs = activeMessages ?? []
                let filtered = conversationMessages(msgs)
                let prompt = filtered.first(where: { $0.role == .user })?.content
                Transcript(
                    messages: filtered,
                    unifiedTurnView: true,
                    pinnedPrompt: prompt,
                    isRunning: dispatchIsRunning,
                    onRewind: nil,
                    agents: childAgents ?? [],
                    onOpenDispatch: onOpenChildDispatch,
                    isNearBottom: $transcriptNearBottom,
                    forceScrollCounter: transcriptForceScroll,
                    alwaysShowAgentPanel: true
                )
            }
            .onReceive(Timer.publish(every: 1, on: .main, in: .common).autoconnect()) { t in
                if agent.status == "running" { now = t }
            }
        } else {
            // Inline layout (AgentBarRow): single VStack, caller owns scrolling.
            VStack(alignment: .leading, spacing: 6) {
                headerView
                bodyView
            }
            .padding(.vertical, 6)
            .onAppear { logDispatchState(event: "onAppear") }
            .onChange(of: selectedDispatchIndex) { _ in logDispatchState(event: "selectionChange") }
        }
    }

    // MARK: - Header view (model tag + dispatch picker)

    /// The pinned header: model tag and dispatch picker.
    /// Rendered above the ScrollView in pinned layout; inline in default layout.
    @ViewBuilder var headerView: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Model tag + duration (duration shown only in pinned layout to
            // avoid doubling the duration that AgentBarRow.headerRow already
            // shows in the compact row above the inline expand).
            let activeModel = activeDispatch?.model ?? agent.model
            if (activeModel != nil && !(activeModel?.isEmpty ?? true)) || (pinHeader && elapsedSeconds != nil) {
                HStack(spacing: 4) {
                    if let model = activeModel, !model.isEmpty {
                        Image(systemName: "cpu")
                            .font(.caption2)
                        Text(modelLabel(model))
                            .font(.caption2)
                    }
                    if pinHeader, let secs = elapsedSeconds {
                        if activeModel != nil && !(activeModel?.isEmpty ?? true) {
                            Text("|")
                                .font(.caption2)
                                .opacity(0.4)
                        }
                        Image(systemName: "clock")
                            .font(.caption2)
                        Text(AgentDuration.format(secs))
                            .font(.caption2.monospacedDigit())
                    }
                }
                .foregroundStyle(theme.textSecondary.opacity(0.5))
                .padding(.horizontal, 12)
                .padding(.top, pinHeader ? 8 : 0)
            }

            // Dispatch picker (shown when multiple dispatches exist)
            if agent.dispatches.count > 1 {
                dispatchPicker
            }
        }
        .padding(.bottom, pinHeader ? 4 : 0)
    }

    // MARK: - Body view (conversation transcript)

    /// The scrollable transcript: messages, loading indicator, or fallback.
    /// Branch selection is delegated to DispatchBodyState.branch so the
    /// decision logic is unit-testable apart from the SwiftUI view.
    @ViewBuilder var bodyView: some View {
        let msgs = activeMessages
        let branch = DispatchBodyState.branch(
            hasMessages: !(msgs?.isEmpty ?? true),
            isLoading: isLoadingMessages,
            hasActiveDispatch: activeDispatch != nil,
            hasFullOutput: !(agent.fullOutput?.isEmpty ?? true),
            isRunning: dispatchIsRunning
        )
        VStack(alignment: .leading, spacing: 0) {
            // Agent conversation history (loaded on expand).
            // When loaded, replaces fullOutput (matches desktop behavior).
            // Tool and thinking rows are rendered via EngineToolGroupRow /
            // EngineMessageRow for parity with the main conversation and
            // desktop ToolGroup.
            switch branch {
            case .messages:
                let filtered = conversationMessages(msgs ?? [])
                let items = groupConversationItems(filtered, unifiedTurnView: true)
                ForEach(Array(items.enumerated()), id: \.element.id) { _, item in
                    dispatchRow(for: item)
                }
            case .loading:
                HStack(spacing: 6) {
                    ProgressView().scaleEffect(0.6)
                    Text("Loading conversation…")
                        .font(.caption2)
                        .foregroundStyle(theme.textSecondary.opacity(0.5))
                }
                .padding(.horizontal, 12)
            case .fullOutput:
                // Fallback: show fullOutput only when no conversation loaded
                // and no specific dispatch is selected. In multi-dispatch mode
                // fullOutput is the agent's global output — not scoped to the
                // selected dispatch — so showing it would leak previous
                // dispatch content into a new dispatch that hasn't responded yet.
                if let fullOutput = agent.fullOutput, !fullOutput.isEmpty {
                    MarkdownContentView(
                        blocks: MarkdownBlockCache.shared.blocks(for: fullOutput)
                    )
                    .textSelection(.enabled)
                    .padding(.horizontal, 12)
                }
            case .working:
                HStack(spacing: 6) {
                    ProgressView().scaleEffect(0.6)
                    Text("Working…")
                        .font(.caption2)
                        .foregroundStyle(theme.textSecondary.opacity(0.5))
                }
                .padding(.horizontal, 12)
            case .noTranscript:
                // A specific dispatch is selected but it is not running and has no
                // transcript (empty conversationId, or no cached messages). The
                // engine recorded no conversation for this dispatch — show the
                // honest static state, never a spinner that implies live work.
                Text("No transcript recorded for this dispatch")
                    .font(.caption2)
                    .foregroundStyle(theme.textSecondary.opacity(0.5))
                    .padding(.horizontal, 12)
            case .empty:
                EmptyView()
            }
        }
        .padding(.vertical, pinHeader ? 8 : 0)
        .onAppear {
            if !pinHeader { return }
            logDispatchState(event: "onAppear")
        }
        .onChange(of: selectedDispatchIndex) { _ in
            if !pinHeader { return }
            logDispatchState(event: "selectionChange")
        }
    }

    // MARK: - Dispatch row rendering

    /// Marker classification for a dispatch transcript row. Extracted as a pure
    /// enum + classifier so the marker-handling parity with Transcript.swift is
    /// unit-testable without rendering SwiftUI. A `.system` divider message
    /// (`──` prefix) is NOT a plain system row — it must render through the
    /// divider-flanked `PlanDividerLabel` treatment (steer applied, plan
    /// created/updated, implementing) exactly like the main transcript does.
    enum DispatchRowKind: Equatable {
        case toolGroup
        case thinking
        case compaction
        case agentTurn
        /// A lifecycle divider (`──` prefix): steer applied, plan created,
        /// plan updated, implementing plan. Rendered via PlanDividerLabel.
        case divider
        /// An ordinary message row (user / assistant / non-divider system).
        case message
    }

    /// Classifies a grouped conversation item into the row kind the dispatch
    /// preview renders. Mirrors Transcript.swift's switch: divider system
    /// messages route to PlanDividerLabel, compaction to CompactionRowView.
    ///
    /// Test seam: `AgentExpandedContent.classifyRow(_:)` lets a unit test assert
    /// that steer / plan-created / plan-updated / plan-implemented / compaction
    /// items each produce their dedicated marker row instead of collapsing into
    /// a plain message row.
    static func classifyRow(_ item: ConversationItem) -> DispatchRowKind {
        switch item {
        case .toolGroup:
            return .toolGroup
        case .thinking:
            return .thinking
        case .compaction:
            return .compaction
        case .agentTurn:
            return .agentTurn
        case .system(let msg):
            // Lifecycle dividers (steer / plan created / plan updated /
            // implementing) carry the `──` sentinel prefix — same detection
            // EngineMessageRow.engineSystemBubble uses.
            return msg.content.hasPrefix("──") ? .divider : .message
        case .user, .assistant:
            return .message
        }
    }

    /// Renders a single grouped conversation item, mirroring the row switch in
    /// Transcript.swift so the dispatch preview shows steer / plan / compaction
    /// markers with the same components as the main transcript.
    @ViewBuilder
    private func dispatchRow(for item: ConversationItem) -> some View {
        switch item {
        case .toolGroup(let tools):
            EngineToolGroupRow(tools: tools)
                .padding(.horizontal, 10)
        case .thinking(let msg):
            ThinkingRowView(message: msg)
                .padding(.horizontal, 12)
        case .compaction(let msg):
            CompactionRowView(message: msg)
                .padding(.horizontal, 10)
        case .agentTurn(let tools, let assistants, let isActive):
            AgentTurnRow(tools: tools, assistantMessages: assistants, isActive: isActive)
                .padding(.horizontal, 10)
        case .system(let msg):
            if msg.content.hasPrefix("──") {
                // Lifecycle divider (steer applied, plan created/updated,
                // implementing) — render with the same divider-flanked
                // PlanDividerLabel treatment the main transcript uses so the
                // marker is visible in the dispatch preview instead of a plain
                // centered line. onTapPlan is intentionally nil here: the
                // dispatch preview has no plan-preview navigation, so the slug
                // degrades to plain text (PlanDividerLabel handles that).
                HStack(spacing: 8) {
                    VStack { Divider() }
                    PlanDividerLabel(message: msg)
                    VStack { Divider() }
                }
                .padding(.horizontal, 24)
                .padding(.vertical, 6)
            } else {
                EngineMessageRow(message: msg)
                    .padding(.horizontal, 12)
            }
        case .user(let msg), .assistant(let msg):
            EngineMessageRow(message: msg)
                .padding(.horizontal, 12)
        }
    }

    // MARK: - Elapsed seconds (pinned layout only)

    private var elapsedSeconds: Int? {
        // When a specific dispatch is selected (pager / multi-dispatch), compute
        // strictly from that dispatch's own status/startTime/elapsed. Do NOT fall
        // back to the live agent's clock — a dispatch with no startTime and a
        // non-running status must show no ticking timer rather than borrowing the
        // agent's running duration. Only the single-dispatch (activeDispatch == nil)
        // path falls back to the agent-level values.
        if let dispatch = activeDispatch {
            return AgentDuration.elapsedSeconds(
                status: dispatch.status,
                startTime: dispatch.startTime,
                elapsed: dispatch.elapsed,
                now: now
            )
        }
        return AgentDuration.elapsedSeconds(
            status: agent.status,
            startTime: agent.startTime,
            elapsed: agent.elapsed,
            now: now
        )
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

    // MARK: - Conversation rendering

    /// Filter messages for display. Drops empty assistant rows.
    /// Preserves tool, thinking, user, and all other roles.
    private func conversationMessages(_ msgs: [Message]) -> [Message] {
        return msgs.filter { msg in
            // Drop empty assistant rows.
            if msg.role == .assistant && msg.content.isEmpty {
                return false
            }
            return true
        }
    }

    // MARK: - Helpers

    private func modelLabel(_ model: String) -> String {
        if model.contains("opus") { return "Opus" }
        if model.contains("sonnet") { return "Sonnet" }
        if model.contains("haiku") { return "Haiku" }
        return model
    }

    private func logDispatchState(event: String) {
        let idx = selectedDispatchIndex ?? (agent.dispatches.count - 1)
        let dispatch = agent.dispatches.indices.contains(idx) ? agent.dispatches[idx] : nil
        let dispatchId = dispatch?.id ?? ""
        let convId = dispatch?.conversationId ?? ""
        let rawCount = activeMessages?.count ?? 0
        let filtered = conversationMessages(activeMessages ?? [])
        let toolCount = filtered.filter { $0.role == .tool }.count
        let assistantCount = filtered.filter { $0.role == .assistant }.count
        let thinkingCount = filtered.filter { $0.role == .thinking }.count
        let userCount = filtered.filter { $0.role == .user }.count
        DiagnosticLog.log("DISPATCH-VIEW: \(event) idx=\(idx) convId=\(convId) dispatchId=\(dispatchId) raw=\(rawCount) filtered=\(filtered.count) tool=\(toolCount) assistant=\(assistantCount) thinking=\(thinkingCount) user=\(userCount)")
    }
}

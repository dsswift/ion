import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

struct ConversationView: View {
    @Environment(\.appTheme) var theme
    let tabId: String
    @Environment(SessionViewModel.self) var viewModel
    @FocusState var isInputFocused: Bool
    @State var agentsPanelExpanded: Bool? = nil
    @State var agentPanelFullscreen = false
    @State var selectedDispatchId: String?
    @State var showStatusDrawer = false
    /// Set to the plan file path when the user taps a plan-lifecycle divider's
    /// slug link; drives the plan-preview full-screen cover (PlanContentView).
    @State var selectedPlanPath: IdentifiablePath?
    @State var isNearBottom = true
    @State var forceScrollCounter = 0
    @State var showFileExplorer = false
    @State var showGitPane = false
    @State var showTerminal = false
    @State var pendingAttachments: [PendingAttachment] = []
    @State var showAttachMenu = false
    @State var showAttachments = false
    @State var showFilePicker = false
    @State var showPhotoPicker = false
    @State var showDocumentPicker = false
    @State var photosPickerItems: [PhotosPickerItem] = []
    /// Set to true when a reconnect-triggered reload is in flight so the next
    /// engine-message count change force-scrolls to the bottom.
    @State var pendingScrollAfterReload = false
    @State var isRecordingVoice = false
    @State var showPermissionDeniedAlert = false
    /// Draft text snapshot taken when recording starts, used to restore on cancel.
    @State var draftBeforeRecording = ""
    /// Slash command autocomplete: nil = menu hidden; non-nil = the current "/" prefix text.
    @State var slashFilter: String?

    var instances: [ConversationInstanceInfo] {
        viewModel.conversationInstances[tabId] ?? []
    }
    /// Whether this tab is an extension-hosted (engine) conversation. Gates the
    /// engine-only chrome (agents panel, instance bar, extension name in the
    /// status bar). Post-#256 this same view renders every non-terminal tab —
    /// plain or engine — and the engine-specific surface self-hides for plain
    /// tabs via this flag.
    var tabHasExtensions: Bool {
        viewModel.tab(for: tabId)?.hasEngineExtension == true
    }
    var activeInstanceId: String {
        viewModel.activeEngineInstance[tabId] ?? instances.first?.id ?? ""
    }
    /// Two-way binding to the per-engine-instance draft owned by SessionViewModel.
    /// Re-evaluates `activeInstanceId` on every access, so switching instances
    /// transparently surfaces that instance's draft — no manual save/restore.
    var promptTextBinding: Binding<String> {
        Binding(
            get: { viewModel.engineDraft(tabId: tabId, instanceId: activeInstanceId) },
            set: { viewModel.setEngineDraft(tabId: tabId, instanceId: activeInstanceId, $0) }
        )
    }
    var promptText: String { viewModel.engineDraft(tabId: tabId, instanceId: activeInstanceId) }
    // Post-#256: the engine session key is bare tabId. The `compoundKey` name is
    // retained to avoid a wide rename across this view's usage sites (engine
    // dialog lookup, extension-commands lookup, AgentDetail), but it is simply
    // the tabId.
    var compoundKey: String { tabId }

    /// Whether the agent panel is expanded. `nil` means the user hasn't
    /// toggled it manually this session — fall back to the desktop setting
    /// `agentPanelDefaultOpen` (default `true` when setting is absent).
    ///
    /// Resolution order: explicit override (agentsPanelExpanded) >
    /// agentPanelDefaultOpen setting > true.
    var isAgentsPanelExpanded: Bool {
        if let explicit = agentsPanelExpanded { return explicit }
        return AgentPanelDefaultResolver.resolveAgentPanelDefault(viewModel.desktopSettings)
    }

    /// Two-way binding for the agent panel expanded state. Reads through the
    /// settings-fallback `isAgentsPanelExpanded` computed var so the settings
    /// default is preserved; writes directly to `agentsPanelExpanded` so the
    /// explicit override takes effect. Passed into Transcript -> TranscriptAgentSection.
    var agentsPanelExpandedBinding: Binding<Bool> {
        Binding(
            get: { isAgentsPanelExpanded },
            set: { agentsPanelExpanded = $0 }
        )
    }

    var visibleAgents: [AgentStateUpdate] {
        (viewModel.engineInstance(tabId: tabId, instanceId: activeInstanceId)?.agentStates ?? [])
            .filter { $0.isVisible && $0.isRootLevel }
            .sorted { a, b in
                let statusOrder: [String: Int] = ["running": 0, "done": 1, "error": 1, "cancelled": 1, "idle": 2]
                let visOrder: [String: Int] = ["always": 0, "sticky": 1, "ephemeral": 2]
                let sa = statusOrder[a.status] ?? 2
                let sb = statusOrder[b.status] ?? 2
                if sa != sb { return sa < sb }
                let va = visOrder[a.visibility] ?? 9
                let vb = visOrder[b.visibility] ?? 9
                if va != vb { return va < vb }
                return a.displayName.localizedCompare(b.displayName) == .orderedAscending
            }
    }

    var runningAgentCount: Int {
        visibleAgents.filter { $0.status == "running" }.count
    }

    /// Active tool calls for this tab, sorted by start time (oldest first).
    /// Read from the flat toolId-keyed store; the StatusDrawerView renders these.
    var activeToolsList: [ActiveToolInfo] {
        guard let tools = viewModel.activeTools[tabId] else { return [] }
        return Array(tools.values).sorted { $0.startTime < $1.startTime }
    }

    var engineMsgs: [Message] {
        viewModel.engineInstance(tabId: tabId, instanceId: activeInstanceId)?.messages ?? []
    }

    var engineAttachmentCount: Int {
        viewModel.tabAttachmentCache[tabId]?.count ?? 0
    }

    static let bootstrapPrefix = "Session bootstrapped"

    var unifiedTurnView: Bool {
        if let settings = viewModel.desktopSettings,
           let val = settings.currentValue(for: "unifiedTurnView"),
           let flag = val.value as? Bool {
            return flag
        }
        return true
    }

    var workingDirectory: String {
        viewModel.tab(for: tabId)?.workingDirectory ?? ""
    }
    var hasUploading: Bool {
        pendingAttachments.contains { $0.isUploading }
    }
    var isRunning: Bool {
        let tab = viewModel.tab(for: tabId)
        return tab?.status == .running || tab?.status == .connecting
    }

    /// Merged slash commands for autocomplete: filesystem-discovered + /clear builtin + extension-registered.
    var slashCommands: [DiscoveredSlashCommand] {
        var cmds = viewModel.discoveredCommands[workingDirectory] ?? []

        // Inject the /clear builtin (matches desktop's SLASH_COMMANDS constant).
        let clearCmd = DiscoveredSlashCommand(
            name: "clear", description: "Clear conversation history",
            scope: "builtin", source: "builtin", origin: nil
        )
        if !cmds.contains(where: { $0.name == "clear" }) {
            cmds.insert(clearCmd, at: 0)
        }

        // Merge extension-registered commands from engine_command_registry.
        if let extCmds = viewModel.extensionCommands[compoundKey] {
            for ec in extCmds where !cmds.contains(where: { $0.name == ec.name }) {
                cmds.append(DiscoveredSlashCommand(
                    name: ec.name,
                    description: ec.description ?? ec.name,
                    scope: "extension",
                    source: "extension",
                    origin: nil
                ))
            }
        }
        return cmds
    }

    func updateSlashFilter(_ text: String) {
        let pattern = #"^\/[a-zA-Z0-9_:\-]*$"#
        if text.range(of: pattern, options: .regularExpression) != nil {
            slashFilter = text
        } else {
            slashFilter = nil
        }
    }

    func fetchCommandsIfNeeded() {
        let dir = workingDirectory
        guard !dir.isEmpty, viewModel.discoveredCommands[dir] == nil else { return }
        viewModel.discoverCommands(directory: dir)
    }

    func logAttachmentTaskEntry(tabId: String) {
        let count = viewModel.tabAttachmentCache[tabId]?.count ?? -1
        DiagnosticLog.log("conversation view attachment task", tag: "view.conversation", fields: [
            "tab_id": String(tabId.prefix(8)),
            "count": String(count)
        ])
    }

    /// Load conversation history via the unified wire command.
    /// WI-004 / #259: desktop_load_conversation handles every tab — plain and
    /// extension-hosted alike. The former tabHasExtensions fork
    /// (desktop_load_engine_conversation for engine tabs) is retired: with
    /// WI-001/WI-002 landed all messages live on the active instance regardless
    /// of backend, and the unified handler pushes live engine state when the
    /// session is running. Extracted from the `.task` closures so the `body`
    /// modifier chain stays within the Swift type-checker's complexity budget.
    @MainActor
    func loadConversationHistory() {
        viewModel.loadConversation(tabId: tabId)
    }

    /// First pending permission request for this tab. Two sources, in order:
    ///
    ///   1. The live `permissionQueue` on the tab snapshot. For engine tabs the
    ///      desktop forwards denials (and auto-allowed plan/question tools) into
    ///      this queue, scoped by `instanceId`; entries from a sibling instance
    ///      are skipped.
    ///   2. A *restored* special card synthesized from history
    ///      (`PendingCard.restoredCard`) when the queue is empty — so an
    ///      ExitPlanMode / AskUserQuestion that the engine already auto-allowed
    ///      survives a history reload and still renders. This used to be
    ///      ConversationView-only; post-#256 the merged view restores cards for
    ///      engine tabs too (Phase 5), honoring the same dismissal-suppression
    ///      sets so a dismissed card does not re-appear.
    var pendingPermission: PermissionRequest? {
        let tab = viewModel.tab(for: tabId)
        let queue = tab?.permissionQueue ?? []
        let status = tab?.status
        for request in queue {
            if let owner = request.instanceId, owner != activeInstanceId {
                DiagnosticLog.log("pending permission skipping", tag: "view.perm", fields: [
                    "tool": request.toolName,
                    "question_id": String(request.questionId.prefix(16)),
                    "reason": String(owner.prefix(8)),
                    "status": String(activeInstanceId.prefix(8))
                ])
                continue
            }
            let inputKeys = request.toolInput?.keys.sorted() ?? []
            DiagnosticLog.log("pending permission from queue", tag: "view.perm", fields: [
                "tool": request.toolName,
                "question_id": request.questionId,
                "reason": request.instanceId?.prefix(8).description ?? "nil",
                "count": String(inputKeys.count),
                "status": status?.rawValue ?? "nil"
            ])
            return request
        }
        // Queue empty — fall back to a restored card synthesized from history,
        // unless the user dismissed it (live or restored scope) on this tab.
        if !viewModel.dismissedLiveSpecialTabs.contains(tabId),
           let restored = PendingCard.restoredCard(for: engineMsgs),
           !viewModel.dismissedRestoredCards.contains(restored.questionId) {
            DiagnosticLog.log("pending permission restored card", tag: "view.perm", fields: [
                "question_id": restored.questionId,
                "tool": restored.toolName
            ])
            return restored
        }
        DiagnosticLog.log("pending permission nil", tag: "view.perm", fields: [
            "count": String(queue.count),
            "status": status?.rawValue ?? "nil",
            "tab_id": String(tabId.prefix(8)),
            "reason": String(activeInstanceId.prefix(8))
        ])
        return nil
    }

    /// First pending extension elicitation (ctx.elicit) for this tab. The engine
    /// parks the run on an indefinite human-wait until it is answered, so this
    /// card renders regardless of running state (unlike a post-turn permission
    /// card). Nil when the queue is empty / absent (older desktops).
    var pendingElicitation: ElicitationRequest? {
        viewModel.tab(for: tabId)?.elicitationQueue?.first
    }

    // MARK: - Extracted sub-views

    private var headerSection: some View {
        VStack(spacing: 0) {
            if let fields = viewModel.engineInstance(tabId: tabId, instanceId: activeInstanceId)?.statusFields {
                GeometryReader { geo in
                    Rectangle()
                        .fill(contextBarColor(fields.contextPercent))
                        .frame(width: geo.size.width * min(CGFloat(fields.contextPercent) / 100, 1))
                }
                .frame(height: 3)
                .background(Color(.tertiarySystemFill))
            }

            if instances.count > 1 {
                EngineInstanceBar(
                    tabId: tabId,
                    instances: instances,
                    activeInstanceId: activeInstanceId
                )
            }

            let working = viewModel.workingMessage(tabId)
            if !working.isEmpty {
                HStack {
                    ProgressView()
                        .scaleEffect(0.7)
                    Text(working)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(Capsule().fill(Color(.tertiarySystemFill)))
                .padding(.horizontal, 12)
                .padding(.vertical, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private var footerSection: some View {
        // The keyboard utility bar — its `@State keyboardVisible`, the
        // keyboard-show/hide observers, and the animation modifier all
        // live inside EngineKeyboardUtilityBarOverlay (sibling file).
        // The host only forwards the user's toggle preference and the
        // two action bindings (dismiss + draft text) the bar needs.
        VStack(spacing: 0) {
            Divider()
            // The status bar must ALWAYS be visible for engine tabs, exactly as
            // it is for plain conversations (ConversationView renders it
            // unconditionally). Previously this was gated on
            // `statusFields != nil`, so a fresh engine instance (no status yet)
            // showed no bar at all — the model picker, permission toggle, and
            // attachments button vanished. Render the bar always and derive the
            // status-dependent values nil-safely from the optional fields: the
            // status dot / context% / extension name self-hide inside the
            // component when their inputs are absent.
            let activeInst = viewModel.engineInstance(tabId: tabId, instanceId: activeInstanceId)
            let engineInputs = ConversationStatusBar.resolveEngineInputs(
                fields: activeInst?.statusFields,
                fallbackPreferredModel: viewModel.preferredModel,
            )
            ConversationStatusBar(
                modelOverride: activeInst?.modelOverride,
                preferredModel: engineInputs.preferredModel,
                contextPercent: engineInputs.contextPercent,
                contextTokens: nil,
                engineContextWindow: engineInputs.engineContextWindow,
                isRunning: isRunning,
                permissionMode: viewModel.tab(for: tabId)?.permissionMode,
                availableModels: viewModel.availableModels,
                attachmentCount: engineAttachmentCount,
                onSelectModel: { model in
                    viewModel.setModel(tabId: tabId, model: model)
                },
                onToggleMode: {
                    guard let current = viewModel.tab(for: tabId)?.permissionMode else { return }
                    let newMode: PermissionMode = current == .plan ? .auto : .plan
                    viewModel.setPermissionMode(tabId: tabId, mode: newMode)
                },
                onTapAttachments: {
                    showAttachments = true
                },
                onTapContextIndicator: {
                    showStatusDrawer = true
                },
                hasEngineExtension: tabHasExtensions,
                // DATA-driven (#256 follow-up): pass the harness/extension name
                // straight through. The status bar renders the badge iff the
                // name is non-nil/non-empty, so a plain conversation (whose
                // status fields carry no extensionName) simply shows no badge —
                // by absence of data, not a tab-type branch. The former
                // `tabHasExtensions ? … : nil` gate was an illegitimate fork.
                extensionName: engineInputs.extensionName,
                runningAgentCount: runningAgentCount,
                thinkingGloballyEnabled: viewModel.thinkingGloballyEnabled,
                thinkingEffort: activeInst?.thinkingEffort ?? "off",
                onSelectThinkingEffort: { level in
                    viewModel.setThinkingEffort(tabId: tabId, effort: level)
                }
            )
            Divider()
            if !pendingAttachments.isEmpty {
                AttachmentChipsView(attachments: pendingAttachments) { id in
                    pendingAttachments.removeAll { $0.id == id }
                }
            }
            engineInputBar
        }
        .engineKeyboardUtilityBar(
            isEnabled: viewModel.showKeyboardUtilityBarInEngine,
            onDismiss: { isInputFocused = false },
            promptText: promptTextBinding
        )
    }

    private var mainContent: some View {
        VStack(spacing: 0) {
            headerSection
            let transcriptView = Transcript(
                messages: engineMsgs,
                unifiedTurnView: unifiedTurnView,
                pinnedPrompt: viewModel.enginePinnedPrompt[compoundKey],
                isRunning: isRunning,
                onRewind: { messageId in
                    viewModel.engineRewindInstance(
                        tabId: tabId,
                        instanceId: activeInstanceId,
                        messageId: messageId
                    )
                },
                agents: visibleAgents.isEmpty ? nil : visibleAgents,
                onOpenDispatch: { dispatch, agent in
                    selectedDispatchId = dispatch.id
                },
                isNearBottom: $isNearBottom,
                forceScrollCounter: forceScrollCounter,
                onTapPlan: { path in
                    selectedPlanPath = IdentifiablePath(path: path)
                },
                agentPanelExpanded: agentsPanelExpandedBinding,
                agentPanelFullscreen: $agentPanelFullscreen
            )
            if !agentPanelFullscreen {
                transcriptView
            } else {
                transcriptView
                    .frame(height: 100)
            }

            if let request = pendingPermission {
                if PlanCardGate.shouldShowCard(toolName: request.toolName, runningAgentCount: runningAgentCount) {
                    PermissionCardView(tabId: tabId, request: request)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 8)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                } else {
                    // Plan Ready card deferred while a background dispatch is
                    // still running — the orchestrator will resume and revise the
                    // plan once the dispatch reports back. The card returns once
                    // the dispatch ends (the denial is not cleared, only hidden).
                    let _ = DiagnosticLog.log("deferring plan ready card", tag: "view.plancard", fields: [
                        "tab_id": String(tabId.prefix(8)),
                        "count": String(runningAgentCount)
                    ])
                }
            }

            if let elicitation = pendingElicitation {
                ElicitationCardView(tabId: tabId, request: elicitation)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            footerSection
        }
    }

    private var toolbarButtons: some View {
        HStack(spacing: 12) {
            Button { showFileExplorer = true } label: {
                Image(systemName: "folder")
                    .font(.subheadline)
                    .foregroundStyle(theme.accent)
            }
            Button { showGitPane = true } label: {
                Image(systemName: "arrow.triangle.branch")
                    .font(.subheadline)
                    .foregroundStyle(theme.accent)
            }
            Button { showTerminal = true } label: {
                Image(systemName: "terminal")
                    .font(.subheadline)
                    .foregroundStyle(theme.accent)
            }
            // Add-instance button removed in #256 (single-instance collapse).
        }
    }

    private var themedBackground: some View {
        ZStack {
            theme.background
            if let bg = theme.backgroundView {
                bg.opacity(0.35)
            }
        }
        .ignoresSafeArea()
    }

    private var styledMainContent: some View {
        mainContent
            .background(themedBackground)
            .toolbarBackground(theme.background.opacity(0.95), for: .navigationBar)
            .toolbarColorScheme(theme.backgroundView != nil ? .dark : nil, for: .navigationBar)
    }

    var body: some View {
        styledMainContent
        .navigationTitle(viewModel.tab(for: tabId)?.displayTitle ?? "Engine")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                if theme.backgroundView != nil {
                    Text(viewModel.tab(for: tabId)?.displayTitle ?? "Engine")
                        .font(.headline.bold())
                        .foregroundStyle(theme.accent)
                        .shadow(color: theme.accent.opacity(0.8), radius: 4)
                        .shadow(color: theme.accent.opacity(0.4), radius: 10)
                }
            }
            ToolbarItem(placement: .topBarTrailing) { toolbarButtons }
        }
        .task {
            logAttachmentTaskEntry(tabId: tabId)
            loadConversationHistory()
            viewModel.requestLoadAttachments(tabId: tabId)
            fetchCommandsIfNeeded()
            if viewModel.pendingGitPaneTabId == tabId {
                viewModel.pendingGitPaneTabId = nil
                showGitPane = true
            }
        }
        .task(id: compoundKey) {
            // Load immediately when switching to an instance that has no cached
            // messages. The isEmpty guard prevents a redundant fetch when a
            // desktop_conversation_history response is already in flight.
            if engineMsgs.isEmpty {
                loadConversationHistory()
            }
            viewModel.requestLoadAttachments(tabId: tabId)
        }
        .modifier(ConversationPresentationLayers(host: self))
    }

}

/// Carries the merged ConversationView's presentation layer (sheets, covers,
/// pickers, onChange handlers). Split out of `body` so the host view's body
/// expression stays within the Swift type-checker's complexity budget — the
/// long inline chain timed out after the #256 merge folded engine + plain
/// presentation into one view. The two halves keep each sub-chain small.
private struct ConversationPresentationLayers: ViewModifier {
    let host: ConversationView

    func body(content: Content) -> some View {
        host.presentationLayersB(host.presentationLayersA(content))
    }
}

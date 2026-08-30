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
    /// File-path chip tap target (ion-file:// links in assistant markdown).
    /// Presented by presentationLayersA as a FileEditorView cover, mirroring
    /// selectedPlanPath.
    @State var selectedFilePath: IdentifiablePath?
    @State var isNearBottom = true
    @State var forceScrollCounter = 0
    /// The transcript row a chart-attachment tap asked to scroll to, with a
    /// tick so tapping the same chart twice jumps twice. Nil until a tap.
    @State var transcriptJumpRequest: (id: String, chartId: String?, tick: Int)?
    /// Monotonic source for the tick above.
    @State var transcriptJumpTick = 0

    /// Ask the transcript to scroll to a row.
    ///
    /// A method rather than an inline closure at the call site: this view's
    /// body is large enough that an extra capturing closure pushed SwiftUI's
    /// type-checker past its budget.
    ///
    /// The tick is what makes a repeat jump to the same row fire again — an id
    /// alone would compare equal to the previous request and be ignored, so
    /// tapping the same chart twice would do nothing the second time.
    func requestTranscriptJump(to rowId: String, chartId: String? = nil) {
        transcriptJumpTick += 1
        transcriptJumpRequest = (id: rowId, chartId: chartId, tick: transcriptJumpTick)
    }
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
        return tab?.status == .running || tab?.status == .connecting || tab?.status == .waiting
    }

    /// Slash-command autocomplete cluster (`slashCommands`, `updateSlashFilter`)
    /// lives in ConversationView+SlashCommands.swift; the appear-time lifecycle
    /// cluster (`fetchCommandsIfNeeded`, `logAttachmentTaskEntry`,
    /// `loadConversationHistory`) lives in ConversationView+Lifecycle.swift —
    /// both extracted at the size cap, mirroring the +Presentation split.

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
    // The `body` layout chain (headerSection, footerSection, mainContent,
    // toolbarButtons, themedBackground, styledMainContent,
    // conversationLoadFailedBanner) lives in ConversationView+Layout.swift,
    // extracted at the size cap to leave headroom for the conversation-surface
    // rebuild. Those members are `internal` so `body` below and the sub-views
    // reach each other across the file boundary.

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
            fetchCommandsIfNeeded()
            if viewModel.pendingGitPaneTabId == tabId {
                viewModel.pendingGitPaneTabId = nil
                showGitPane = true
            }
        }
        .task(id: compoundKey) {
            // The SINGLE history/attachment load site for this view. This task
            // runs on first appear AND whenever the conversation identity
            // changes, so it covers everything the plain `.task` above used to
            // duplicate — that block fired the same two requests on the same
            // appear, and the desktop coalesced the second away unanswered.
            //
            // No isEmpty guard: `loadConversationIfNeeded` asks the precise
            // question (has this tab ever loaded?), where `engineMsgs.isEmpty`
            // stayed true forever on a conversation with no messages and
            // re-requested history on every single appear.
            loadConversationHistory()
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

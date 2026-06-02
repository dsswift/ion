// @file-size-exception: single-screen view; split deferred per file-organization.md decomposition phase
import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

struct EngineView: View {
    @Environment(\.appTheme) private var theme
    let tabId: String
    @Environment(SessionViewModel.self) var viewModel
    @FocusState private var isInputFocused: Bool
    @State private var agentsPanelExpanded: Bool? = nil
    @State private var agentPanelFullscreen = false
    @State private var selectedAgentId: String?
    @State private var isNearBottom = true
    @State private var forceScrollCounter = 0
    @State private var showFileExplorer = false
    @State private var showGitPane = false
    @State private var showTerminal = false
    @State var pendingAttachments: [PendingAttachment] = []
    @State private var showAttachMenu = false
    @State private var showFilePicker = false
    @State private var showPhotoPicker = false
    @State private var showDocumentPicker = false
    @State private var photosPickerItems: [PhotosPickerItem] = []
    /// Set to true when a reconnect-triggered reload is in flight so the next
    /// engine-message count change force-scrolls to the bottom.
    @State private var pendingScrollAfterReload = false
    @State private var isRecordingVoice = false
    @State private var showPermissionDeniedAlert = false
    /// Draft text snapshot taken when recording starts, used to restore on cancel.
    @State private var draftBeforeRecording = ""

    private var instances: [EngineInstanceInfo] {
        viewModel.engineInstances[tabId] ?? []
    }
    private var activeInstanceId: String {
        viewModel.activeEngineInstance[tabId] ?? instances.first?.id ?? ""
    }
    /// Two-way binding to the per-engine-instance draft owned by SessionViewModel.
    /// Re-evaluates `activeInstanceId` on every access, so switching instances
    /// transparently surfaces that instance's draft — no manual save/restore.
    private var promptTextBinding: Binding<String> {
        Binding(
            get: { viewModel.engineDraft(tabId: tabId, instanceId: activeInstanceId) },
            set: { viewModel.setEngineDraft(tabId: tabId, instanceId: activeInstanceId, $0) }
        )
    }
    private var promptText: String { viewModel.engineDraft(tabId: tabId, instanceId: activeInstanceId) }
    private var compoundKey: String {
        viewModel.engineCompoundKey(tabId: tabId)
    }

    /// Whether the agent panel is expanded. `nil` means the user hasn't
    /// toggled it manually this session — fall back to the desktop setting
    /// `agentPanelDefaultOpen` (default `true` when setting is absent).
    private var isAgentsPanelExpanded: Bool {
        if let explicit = agentsPanelExpanded { return explicit }
        if let settings = viewModel.desktopSettings,
           let val = settings.currentValue(for: "agentPanelDefaultOpen"),
           let flag = val.value as? Bool {
            return flag
        }
        return true
    }

    private var visibleAgents: [AgentStateUpdate] {
        (viewModel.engineAgentStates[compoundKey] ?? [])
            .filter(\.isVisible)
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

    private var runningAgentCount: Int {
        visibleAgents.filter { $0.status == "running" }.count
    }

    private var activeToolsList: [ActiveToolInfo] {
        (viewModel.activeTools[compoundKey] ?? [:]).values.sorted { $0.startTime < $1.startTime }
    }
    private var engineMsgs: [Message] {
        viewModel.engineMessages[compoundKey] ?? []
    }

    private enum GroupedItem: Identifiable {
        case single(Message)
        case toolGroup([Message])
        case compaction(Message)
        var id: String {
            switch self {
            case .single(let msg): return msg.id
            case .toolGroup(let msgs): return "tg-\(msgs.first?.id ?? "")"
            case .compaction(let msg): return "cp-\(msg.id)"
            }
        }
    }

    private static let bootstrapPrefix = "Session bootstrapped"

    private var groupedMessages: [GroupedItem] {
        DiagnosticLog.log("ENGINE-BOOTSTRAP: groupedMessages entry total=\(engineMsgs.count)")
        var result: [GroupedItem] = []
        var toolBuf: [Message] = []
        var bootstrapBuf: [Message] = []
        var totalRunsFlushed = 0
        var totalSuppressed = 0

        let flushBootstrap = {
            guard !bootstrapBuf.isEmpty else { return }
            var representative = bootstrapBuf.last!
            let suppressed = bootstrapBuf.count - 1
            if suppressed > 0 {
                representative.bootstrapCollapsedCount = suppressed
            }
            DiagnosticLog.log(
                "ENGINE-BOOTSTRAP: flush run count=\(bootstrapBuf.count) kept=\(representative.id) suppressed=\(suppressed)"
            )
            result.append(.single(representative))
            totalRunsFlushed += 1
            totalSuppressed += suppressed
            bootstrapBuf = []
        }

        for msg in engineMsgs {
            if msg.role == .tool {
                flushBootstrap()
                toolBuf.append(msg)
            } else {
                if !toolBuf.isEmpty {
                    result.append(.toolGroup(toolBuf))
                    toolBuf = []
                }
                if msg.role == .harness && msg.content.hasPrefix(Self.bootstrapPrefix) {
                    DiagnosticLog.log("ENGINE-BOOTSTRAP: enqueue id=\(msg.id) buf=\(bootstrapBuf.count + 1)")
                    bootstrapBuf.append(msg)
                } else if msg.content.hasPrefix("[Compaction]") {
                    flushBootstrap()
                    result.append(.compaction(msg))
                } else {
                    flushBootstrap()
                    result.append(.single(msg))
                }
            }
        }
        flushBootstrap()
        if !toolBuf.isEmpty {
            result.append(.toolGroup(toolBuf))
        }
        DiagnosticLog.log(
            "ENGINE-BOOTSTRAP: groupedMessages done runs=\(totalRunsFlushed) suppressed=\(totalSuppressed) output=\(result.count)"
        )
        return result
    }

    private var workingDirectory: String {
        viewModel.tab(for: tabId)?.workingDirectory ?? ""
    }
    private var hasUploading: Bool {
        pendingAttachments.contains { $0.isUploading }
    }
    private var isRunning: Bool {
        let tab = viewModel.tab(for: tabId)
        return tab?.status == .running || tab?.status == .connecting
    }

    /// First pending permission request for this engine tab.
    /// Engine tabs don't need the restored-card logic from ConversationView —
    /// the desktop forwards engine denials via the per-instance Map into
    /// `permissionQueue` on the tab snapshot, so the queue is the single
    /// source of truth.
    private var pendingPermission: PermissionRequest? {
        let tab = viewModel.tab(for: tabId)
        let queue = tab?.permissionQueue ?? []
        let status = tab?.status
        if let request = queue.first {
            let inputKeys = request.toolInput?.keys.sorted() ?? []
            DiagnosticLog.log("ENGINE-PERM: pendingPermission: from queue — toolName=\(request.toolName) questionId=\(request.questionId) inputKeys=\(inputKeys) status=\(status?.rawValue ?? "nil")")
            return request
        }
        DiagnosticLog.log("ENGINE-PERM: pendingPermission: nil (queueSize=\(queue.count) status=\(status?.rawValue ?? "nil") tabId=\(tabId.prefix(8)))")
        return nil
    }

    // MARK: - Extracted sub-views

    private var chatItems: [ChatItem<GroupedItem>] {
        groupedMessages.map { ChatItem(id: $0.id, payload: $0) }
    }

    private var conversationScroll: some View {
        ZStack(alignment: .bottom) {
            ChatCollectionView(
                items: chatItems,
                isNearBottom: $isNearBottom,
                forceScrollCounter: forceScrollCounter,
                spacing: 8,
                horizontalInset: 12
            ) { item in
                Group {
                    switch item {
                    case .single(let msg):
                        EngineMessageRow(message: msg)
                    case .toolGroup(let tools):
                        EngineToolGroupRow(tools: tools)
                    case .compaction(let msg):
                        CompactionRowView(message: msg)
                    }
                }
            }

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
    }

    private var agentSection: some View {
        VStack(spacing: 0) {
            HStack(spacing: 4) {
                Button {
                    withAnimation(IonTheme.snappySpring) {
                        agentsPanelExpanded = !isAgentsPanelExpanded
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: isAgentsPanelExpanded ? "chevron.down" : "chevron.right")
                            .font(.caption2)
                        Text("Agents")
                            .font(.caption.weight(.semibold))
                        Text("(\(visibleAgents.count))")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                        if runningAgentCount > 0 {
                            Text("\(runningAgentCount) active")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(theme.accent)
                        }
                    }
                    .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)

                Spacer()

                Button {
                    withAnimation(IonTheme.snappySpring) {
                        agentPanelFullscreen.toggle()
                    }
                } label: {
                    Image(systemName: agentPanelFullscreen
                          ? "arrow.down.right.and.arrow.up.left"
                          : "arrow.up.left.and.arrow.down.right")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 4)

            if isAgentsPanelExpanded {
                let usePopup = viewModel.agentPanelFullScreenPopup
                let agentList = ScrollView {
                    VStack(spacing: 4) {
                        ForEach(visibleAgents) { agent in
                            AgentBarRow(
                                agent: agent,
                                messages: viewModel.agentConversationMessages[agent.name],
                                conversationMessages: viewModel.agentConversationMessages,
                                isLoadingMessages: viewModel.agentConversationLoading.contains(agent.name)
                                    || agent.dispatches.contains { viewModel.agentConversationLoading.contains($0.conversationId) },
                                onExpand: {
                                    if let lastDispatch = agent.dispatches.last,
                                       !lastDispatch.conversationId.isEmpty {
                                        viewModel.loadAgentDispatchConversation(
                                            agent: agent,
                                            conversationId: lastDispatch.conversationId
                                        )
                                    } else {
                                        viewModel.loadAgentConversation(agent: agent)
                                    }
                                },
                                onLoadDispatch: { convId in
                                    viewModel.loadAgentDispatchConversation(agent: agent, conversationId: convId)
                                },
                                onPreloadDispatches: { excludingConvId in
                                    viewModel.preloadAgentDispatches(agent: agent, excluding: excludingConvId)
                                },
                                onTap: usePopup ? {
                                    // No-op when agent has no content to display
                                    guard !agent.dispatches.isEmpty || agent.fullOutput != nil || agent.status == "running" else { return }
                                    // Load conversation data before presenting
                                    if let lastDispatch = agent.dispatches.last,
                                       !lastDispatch.conversationId.isEmpty {
                                        viewModel.loadAgentDispatchConversation(
                                            agent: agent,
                                            conversationId: lastDispatch.conversationId
                                        )
                                    } else {
                                        viewModel.loadAgentConversation(agent: agent)
                                    }
                                    if let lastConvId = agent.dispatches.last?.conversationId, !lastConvId.isEmpty {
                                        viewModel.preloadAgentDispatches(agent: agent, excluding: lastConvId)
                                    }
                                    selectedAgentId = agent.id
                                } : nil
                            )
                        }
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 6)
                }

                if agentPanelFullscreen {
                    agentList
                } else {
                    agentList.frame(maxHeight: 132)
                }
            }
        }
    }

    private var headerSection: some View {
        VStack(spacing: 0) {
            if let fields = viewModel.engineStatusFields[compoundKey] {
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

            if let working = viewModel.engineWorkingMessages[compoundKey], !working.isEmpty {
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

            if let prompt = viewModel.enginePinnedPrompt[compoundKey], !prompt.isEmpty {
                HStack {
                    Text("> ")
                        .foregroundStyle(theme.accent)
                        .fontWeight(.semibold)
                    Text(prompt)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                .font(IonTheme.codeFont(size: 12))
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(.secondarySystemFill).opacity(0.7))
            }
        }
    }

    private var footerSection: some View {
        VStack(spacing: 0) {
            Divider()
            if let fields = viewModel.engineStatusFields[compoundKey] {
                ConversationStatusBar(
                    modelOverride: viewModel.engineModelOverrides[compoundKey],
                    preferredModel: fields.model,
                    contextPercent: fields.contextPercent,
                    contextTokens: nil,
                    isRunning: isRunning,
                    permissionMode: viewModel.tab(for: tabId)?.permissionMode,
                    availableModels: viewModel.availableModels,
                    attachmentCount: 0,
                    onSelectModel: { model in
                        viewModel.setEngineModel(tabId: tabId, model: model)
                    },
                    onToggleMode: {
                        guard let current = viewModel.tab(for: tabId)?.permissionMode else { return }
                        let newMode: PermissionMode = current == .plan ? .auto : .plan
                        viewModel.setPermissionMode(tabId: tabId, mode: newMode)
                    },
                    onTapAttachments: {},
                    isEngine: true,
                    extensionName: fields.extensionName,
                    statusState: fields.state
                )
            }
            Divider()
            if !pendingAttachments.isEmpty {
                AttachmentChipsView(attachments: pendingAttachments) { id in
                    pendingAttachments.removeAll { $0.id == id }
                }
            }
            engineInputBar
        }
    }

    private var mainContent: some View {
        VStack(spacing: 0) {
            headerSection
            if !agentPanelFullscreen {
                conversationScroll
            } else {
                conversationScroll
                    .frame(height: 100)
            }

            if !activeToolsList.isEmpty {
                VStack(spacing: 4) {
                    ForEach(activeToolsList) { tool in
                        ActiveToolRow(tabId: tabId, tool: tool)
                    }
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
            }

            if let request = pendingPermission {
                PermissionCardView(tabId: tabId, request: request)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            if !visibleAgents.isEmpty {
                agentSection
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
            Button { viewModel.addEngineInstance(tabId: tabId) } label: {
                Image(systemName: "plus.rectangle")
                    .foregroundStyle(theme.accent)
            }
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
            viewModel.loadEngineConversation(tabId: tabId)
        }
        .task(id: compoundKey) {
            // Load immediately when switching to an instance that has no cached
            // messages (e.g. after moveEngineInstance changes the active instance
            // on the source tab). The isEmpty guard prevents a redundant fetch
            // when the engine is about to push engineConversationHistory itself.
            if engineMsgs.isEmpty {
                viewModel.loadEngineConversation(tabId: tabId)
            }
        }
        .sheet(item: Binding(
            get: { viewModel.engineDialogs[compoundKey] ?? nil },
            set: { _ in }
        )) { dialog in
            EngineDialogSheet(tabId: tabId, dialog: dialog)
        }
        .fullScreenCover(isPresented: $showGitPane) {
            GitPaneView(tabId: tabId)
                .environment(viewModel)
        }
        .fullScreenCover(isPresented: $showTerminal) {
            ConversationTerminalView(tabId: tabId)
                .environment(viewModel)
        }
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
        .fullScreenCover(isPresented: $showFileExplorer) {
            FileExplorerView(tabId: tabId)
                .environment(viewModel)
        }
        .fullScreenCover(isPresented: Binding(
            get: { selectedAgentId != nil },
            set: { if !$0 { selectedAgentId = nil } }
        )) {
            if let agentId = selectedAgentId {
                AgentDetailFullScreenView(
                    agentId: agentId,
                    compoundKey: compoundKey
                )
                .environment(viewModel)
            }
        }
        .sheet(isPresented: $showFilePicker) {
            FilePickerSheet(initialDirectory: workingDirectory) { path, name in
                addFileAttachment(path: path, name: name)
            }
            .environment(viewModel)
        }
        .onChange(of: viewModel.pendingUploadResults) { _, results in
            consumeUploadResults(results)
        }
        .onChange(of: photosPickerItems) { _, items in
            for item in items { handlePhotoSelection(item) }
            photosPickerItems = []
        }
        .onChange(of: viewModel.connectionState) { oldState, newState in
            handleConnectionStateChange(oldState: oldState, newState: newState)
        }
        .onChange(of: engineMsgs.count) {
            consumePendingScrollAfterReload()
        }
        .photosPicker(
            isPresented: $showPhotoPicker,
            selection: $photosPickerItems,
            maxSelectionCount: 5,
            matching: .images
        )
        .fileImporter(
            isPresented: $showDocumentPicker,
            allowedContentTypes: [.item],
            allowsMultipleSelection: true
        ) { result in
            handleDocumentPickerResult(result)
        }
        .confirmationDialog("Attach", isPresented: $showAttachMenu) {
            Button("Photo Library") { showPhotoPicker = true }
            Button("Choose File") { showDocumentPicker = true }
            Button("Browse Desktop Files") { showFilePicker = true }
            Button("Cancel", role: .cancel) {}
        }
        .animation(.default, value: pendingPermission?.id)
    }

    // MARK: - Engine input bar

    private var engineInputBar: some View {
        HStack(spacing: 8) {
            attachButton
            TextField("Send a prompt...", text: promptTextBinding, axis: .vertical)
                .lineLimit(1...5)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color(.tertiarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: IonTheme.Radius.medium))
                .overlay(RoundedRectangle(cornerRadius: IonTheme.Radius.medium).stroke(
                    isRecordingVoice ? theme.accent.opacity(0.5) : Color(.separator),
                    lineWidth: isRecordingVoice ? 1.5 : 1
                ))
                .focused($isInputFocused)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()

            // Mic area: inline recording strip while active, mic button when idle
            if isRecordingVoice {
                VoiceRecordingStrip(
                    audioLevel: viewModel.speechService.audioLevel,
                    onStop: { stopVoiceRecording() },
                    onCancel: { cancelVoiceRecording() }
                )
                .transition(.opacity.combined(with: .scale(scale: 0.9)))
            } else {
                engineMicButton
            }

            Button { submitPrompt() } label: {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.title)
                    .foregroundStyle(!cannotSend ? theme.accent : Color.gray)
            }
            .disabled(cannotSend)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .animation(IonTheme.snappySpring, value: isRecordingVoice)
        .alert("Microphone Access Required", isPresented: $showPermissionDeniedAlert) {
            Button("Open Settings") {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Ion Remote needs microphone and speech recognition access to transcribe your voice. Enable both in Settings > Privacy.")
        }
        .onChange(of: viewModel.speechService.transcript) { _, newTranscript in
            guard isRecordingVoice else { return }
            let base = draftBeforeRecording
            if newTranscript.isEmpty { return }
            let separator = base.isEmpty ? "" : " "
            viewModel.setEngineDraft(tabId: tabId, instanceId: activeInstanceId, base + separator + newTranscript)
        }
    }

    private var engineMicButton: some View {
        Button {
            startVoiceRecording()
        } label: {
            Image(systemName: "mic.fill")
                .font(.title3)
                .foregroundStyle(engineMicButtonColor)
        }
        .accessibilityLabel("Record voice input")
    }

    private var engineMicButtonColor: Color {
        return viewModel.speechService.permissionState == .denied ? Color(.quaternaryLabel) : .secondary
    }

    private func startVoiceRecording() {
        DiagnosticLog.log("ENGINE-INPUTBAR: startVoiceRecording tapped")
        Haptic.light()
        Task {
            viewModel.speechService.refreshPermissions()
            if viewModel.speechService.permissionState == .denied {
                DiagnosticLog.log("ENGINE-INPUTBAR: permission denied — showing alert")
                showPermissionDeniedAlert = true
                return
            }
            let granted = await viewModel.speechService.requestPermission()
            guard granted else {
                DiagnosticLog.log("ENGINE-INPUTBAR: permission request denied")
                showPermissionDeniedAlert = true
                return
            }
            draftBeforeRecording = promptText
            isInputFocused = false
            do {
                try await viewModel.speechService.startRecording(stoppingVoiceService: viewModel.voiceService)
                isRecordingVoice = true
                DiagnosticLog.log("ENGINE-INPUTBAR: recording started draftSnapshot=\(draftBeforeRecording.prefix(40))")
            } catch {
                DiagnosticLog.log("ENGINE-INPUTBAR: startRecording error: \(error.localizedDescription)")
                isRecordingVoice = false
            }
        }
    }

    private func stopVoiceRecording() {
        DiagnosticLog.log("ENGINE-INPUTBAR: stopVoiceRecording — text already in field")
        viewModel.speechService.cancelRecording()
        isRecordingVoice = false
        Haptic.light()
    }

    private func cancelVoiceRecording() {
        DiagnosticLog.log("ENGINE-INPUTBAR: cancelVoiceRecording — restoring draft snapshot")
        viewModel.speechService.cancelRecording()
        isRecordingVoice = false
        viewModel.setEngineDraft(tabId: tabId, instanceId: activeInstanceId, draftBeforeRecording)
        Haptic.light()
    }

    private var attachButton: some View {
        Button {
            showAttachMenu = true
        } label: {
            Image(systemName: "paperclip")
                .font(.title3)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Actions

    private var cannotSend: Bool {
        let empty = promptText.trimmingCharacters(in: .whitespaces).isEmpty
        return (empty && pendingAttachments.isEmpty) || hasUploading
    }

    /// Re-sync engine history when we recover from a transient disconnect
    /// (e.g. phone locked while the conversation was running). The snapshot
    /// handler also calls `loadEngineConversation` for engine tabs, but this
    /// handler arms `pendingScrollAfterReload` so the view auto-scrolls to
    /// the new bottom once history arrives.
    private func handleConnectionStateChange(oldState: ConnectionState, newState: ConnectionState) {
        guard oldState == .reconnecting && newState == .connected else { return }
        // Only refresh tabs the user has actually opened; unopened tabs are
        // handled by the snapshot prefetch in handleSnapshot.
        guard !engineMsgs.isEmpty else { return }
        DiagnosticLog.log("RESUME-SYNC: EngineView reloading tabId=\(tabId.prefix(8))")
        pendingScrollAfterReload = true
        viewModel.loadEngineConversation(tabId: tabId)
    }

    /// When a reconnect-triggered reload delivers new history, force-scroll
    /// to the bottom regardless of the user's prior scroll position.
    private func consumePendingScrollAfterReload() {
        guard pendingScrollAfterReload else { return }
        pendingScrollAfterReload = false
        isNearBottom = true
        forceScrollCounter += 1
    }

    private func submitPrompt() {
        let trimmed = promptText.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty || !pendingAttachments.isEmpty else { return }
        guard !hasUploading else { return }
        isNearBottom = true
        forceScrollCounter += 1
        Haptic.light()
        let attachments = pendingAttachments.map(\.commandAttachment)
        viewModel.submitEnginePrompt(
            tabId: tabId,
            text: promptText,
            attachments: attachments.isEmpty ? nil : attachments
        )
        isInputFocused = false
        viewModel.setEngineDraft(tabId: tabId, instanceId: activeInstanceId, "")
        pendingAttachments = []
    }

    private func contextBarColor(_ percent: Double) -> Color {
        if percent < 60 { return .green }
        if percent < 80 { return .orange }
        return .red
    }
}

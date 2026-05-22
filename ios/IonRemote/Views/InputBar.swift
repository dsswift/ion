import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

struct InputBar: View {
    @Environment(SessionViewModel.self) private var viewModel
    let tabId: String

    @FocusState private var isFocused: Bool
    @State private var keyboardVisible = false
    @State private var slashFilter: String?
    @State private var placeholderIndex = 0
    @State private var pendingAttachments: [PendingAttachment] = []
    @State private var showAttachMenu = false
    @State private var showFilePicker = false
    @State private var showPhotoPicker = false
    @State private var showDocumentPicker = false
    @State private var photosPickerItems: [PhotosPickerItem] = []
    @State private var isRecordingVoice = false
    @State private var showPermissionDeniedAlert = false
    /// Draft text snapshot taken when recording starts, used to restore on cancel.
    @State private var draftBeforeRecording = ""

    /// Two-way binding to the per-tab draft text owned by SessionViewModel.
    /// Writes propagate synchronously to UserDefaults via `setTabDraft`.
    private var promptTextBinding: Binding<String> {
        Binding(
            get: { viewModel.tabDraft(tabId) },
            set: { viewModel.setTabDraft(tabId, $0) }
        )
    }
    private var promptText: String { viewModel.tabDraft(tabId) }

    private let placeholders = [
        "Ask a question…",
        "Describe what you need…",
        "Type / for commands…"
    ]

    private var tab: RemoteTabState? {
        viewModel.tab(for: tabId)
    }

    private var isRunning: Bool {
        tab?.status == .running || tab?.status == .connecting
    }

    private var isConnected: Bool {
        viewModel.connectionState == .connected
    }

    private var isQueued: Bool {
        isRunning  // Will queue behind current run
    }

    private var workingDirectory: String {
        tab?.workingDirectory ?? ""
    }

    private var slashCommands: [DiscoveredSlashCommand] {
        viewModel.discoveredCommands[workingDirectory] ?? []
    }

    private var hasUploading: Bool {
        pendingAttachments.contains { $0.isUploading }
    }

    var body: some View {
        VStack(spacing: 0) {
            if let filter = slashFilter, !slashCommands.isEmpty {
                SlashCommandMenu(
                    filter: filter,
                    commands: slashCommands,
                    onSelect: { cmd in
                        viewModel.setTabDraft(tabId, "/\(cmd.name) ")
                        slashFilter = nil
                    }
                )
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            if keyboardVisible {
                KeyboardUtilityBar(
                    onDismiss: { isFocused = false },
                    promptText: promptTextBinding
                )
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            Rectangle()
                .fill(
                    LinearGradient(
                        colors: [Color(.separator).opacity(0), Color(.separator), Color(.separator).opacity(0)],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                )
                .frame(height: 0.5)

            // Attachment chips
            if !pendingAttachments.isEmpty {
                AttachmentChipsView(attachments: pendingAttachments) { id in
                    pendingAttachments.removeAll { $0.id == id }
                }
            }

            HStack(spacing: 8) {
                attachButton

                TextField("", text: promptTextBinding, prompt: Text(placeholders[placeholderIndex]).foregroundStyle(.tertiary), axis: .vertical)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color(.tertiarySystemBackground))
                    .clipShape(RoundedRectangle(cornerRadius: IonTheme.Radius.medium))
                    .overlay(RoundedRectangle(cornerRadius: IonTheme.Radius.medium).stroke(
                        isRecordingVoice ? IonTheme.accent.opacity(0.5) : Color(.separator),
                        lineWidth: isRecordingVoice ? 1.5 : 1
                    ))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .lineLimit(1...5)
                    .focused($isFocused)
                    .disabled(!isConnected)
                    .onSubmit { sendMessage() }

                if isRunning {
                    Button {
                        viewModel.cancel(tabId: tabId)
                    } label: {
                        Image(systemName: "stop.circle.fill")
                            .font(.title2)
                            .foregroundStyle(.red)
                            .shadow(color: .red.opacity(0.3), radius: 6)
                    }
                }

                // Mic area: inline recording strip while active, mic button when idle
                if isRecordingVoice {
                    VoiceRecordingStrip(
                        audioLevel: viewModel.speechService.audioLevel,
                        onStop: { stopVoiceRecording() },
                        onCancel: { cancelVoiceRecording() }
                    )
                    .transition(.opacity.combined(with: .scale(scale: 0.9)))
                } else {
                    micButton
                }

                Button {
                    sendMessage()
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title)
                        .foregroundStyle(sendButtonColor)
                }
                .disabled(cannotSend)
            }
            .padding(.horizontal)
            .padding(.vertical, 8)

            if promptText.count > 500 {
                HStack {
                    Spacer()
                    Text("\(promptText.count)")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .padding(.trailing, 16)
                }
            }

            // Queue indicator
            if isQueued && !promptText.isEmpty {
                Text("Message will be queued")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .padding(.bottom, 4)
            }
        }
        .background(.regularMaterial)
        .animation(IonTheme.snappySpring, value: keyboardVisible)
        .animation(IonTheme.snappySpring, value: slashFilter)
        .animation(IonTheme.snappySpring, value: pendingAttachments.count)
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
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
            keyboardVisible = true
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            keyboardVisible = false
        }
        .onChange(of: viewModel.pendingInputByTab[tabId]) { _, newValue in
            if let text = newValue {
                viewModel.setTabDraft(tabId, text)
                viewModel.pendingInputByTab.removeValue(forKey: tabId)
            }
        }
        .onChange(of: promptText) { _, newText in
            updateSlashFilter(newText)
        }
        .onChange(of: viewModel.speechService.transcript) { _, newTranscript in
            // Stream live transcript directly into the draft field while recording.
            // The engine accumulates across utterance pauses, so this is always the
            // full running text — not just the latest segment.
            guard isRecordingVoice else { return }
            let base = draftBeforeRecording
            if newTranscript.isEmpty { return }
            let separator = base.isEmpty ? "" : " "
            viewModel.setTabDraft(tabId, base + separator + newTranscript)
        }
        .onChange(of: viewModel.pendingUploadResults) { _, results in
            consumeUploadResults(results)
        }
        .onChange(of: photosPickerItems) { _, items in
            for item in items { handlePhotoSelection(item) }
            photosPickerItems = []
        }
        .onAppear {
            fetchCommandsIfNeeded()
        }
        .onChange(of: workingDirectory) {
            fetchCommandsIfNeeded()
        }
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(4))
                withAnimation {
                    placeholderIndex = (placeholderIndex + 1) % placeholders.count
                }
            }
        }
        .sheet(isPresented: $showFilePicker) {
            FilePickerSheet(initialDirectory: workingDirectory) { path, name in
                addFileAttachment(path: path, name: name)
            }
            .environment(viewModel)
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
    }

    // MARK: - Attach button

    private var attachButton: some View {
        Button {
            showAttachMenu = true
        } label: {
            Image(systemName: "paperclip")
                .font(.title3)
                .foregroundStyle(isConnected ? .secondary : .quaternary)
        }
        .disabled(!isConnected)
    }

    // MARK: - Mic button

    private var micButton: some View {
        Button {
            startVoiceRecording()
        } label: {
            Image(systemName: "mic.fill")
                .font(.title3)
                .foregroundStyle(micButtonColor)
        }
        .disabled(!isConnected)
        .accessibilityLabel("Record voice input")
    }

    private var micButtonColor: Color {
        guard isConnected else { return Color(.quaternaryLabel) }
        return viewModel.speechService.permissionState == .denied ? Color(.quaternaryLabel) : .secondary
    }

    private func startVoiceRecording() {
        DiagnosticLog.log("INPUTBAR: startVoiceRecording tapped")
        Haptic.light()
        Task {
            viewModel.speechService.refreshPermissions()
            if viewModel.speechService.permissionState == .denied {
                DiagnosticLog.log("INPUTBAR: permission denied — showing alert")
                showPermissionDeniedAlert = true
                return
            }
            let granted = await viewModel.speechService.requestPermission()
            guard granted else {
                DiagnosticLog.log("INPUTBAR: permission request denied")
                showPermissionDeniedAlert = true
                return
            }
            // Snapshot draft so cancel can restore it exactly
            draftBeforeRecording = promptText
            isFocused = false
            do {
                try await viewModel.speechService.startRecording(stoppingVoiceService: viewModel.voiceService)
                isRecordingVoice = true
                DiagnosticLog.log("INPUTBAR: recording started draftSnapshot=\(draftBeforeRecording.prefix(40))")
            } catch {
                DiagnosticLog.log("INPUTBAR: startRecording error: \(error.localizedDescription)")
                isRecordingVoice = false
            }
        }
    }

    private func stopVoiceRecording() {
        DiagnosticLog.log("INPUTBAR: stopVoiceRecording — text already in field")
        // Text is already live in the draft — just stop the engine
        viewModel.speechService.cancelRecording()
        isRecordingVoice = false
        Haptic.light()
    }

    private func cancelVoiceRecording() {
        DiagnosticLog.log("INPUTBAR: cancelVoiceRecording — restoring draft snapshot")
        viewModel.speechService.cancelRecording()
        isRecordingVoice = false
        // Restore the draft to exactly what it was before recording started
        viewModel.setTabDraft(tabId, draftBeforeRecording)
        Haptic.light()
    }

    // MARK: - Actions

    private var cannotSend: Bool {
        let emptyText = promptText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let noAttachments = pendingAttachments.isEmpty
        return (emptyText && noAttachments) || !isConnected || hasUploading
    }

    private func sendMessage() {
        let trimmed = promptText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !pendingAttachments.isEmpty else { return }
        guard !hasUploading else { return }
        Haptic.light()
        let attachments = pendingAttachments.map(\.commandAttachment)
        viewModel.sendPrompt(
            tabId: tabId,
            text: promptText,
            attachments: attachments.isEmpty ? nil : attachments
        )
        isFocused = false
        viewModel.clearTabDraft(tabId)
        pendingAttachments = []
    }

    private var sendButtonColor: Color {
        if !isConnected {
            return .gray
        }
        return isQueued ? .orange : IonTheme.accent
    }

    // MARK: - Attachments

    private func addFileAttachment(path: String, name: String) {
        let imageExts: Set = ["png", "jpg", "jpeg", "gif", "webp", "svg"]
        let ext = (name as NSString).pathExtension.lowercased()
        let type = imageExts.contains(ext) ? "image" : "file"
        let att = PendingAttachment(id: UUID().uuidString, type: type, name: name, path: path, isUploading: false)
        pendingAttachments.append(att)
    }

    private func handlePhotoSelection(_ item: PhotosPickerItem) {
        let placeholderId = UUID().uuidString
        let correlationId = UUID().uuidString
        let name = "photo-\(Int(Date().timeIntervalSince1970 * 1000)).jpeg"
        pendingAttachments.append(PendingAttachment(id: placeholderId, type: "image", name: name, path: "", isUploading: true, correlationId: correlationId))

        Task {
            guard let data = try? await item.loadTransferable(type: Data.self) else {
                await MainActor.run { pendingAttachments.removeAll { $0.id == placeholderId } }
                return
            }
            // Compress to JPEG, target ~1MB max
            let compressed = compressImage(data: data, maxBytes: 1_000_000)
            AttachmentImageCache.shared.store(data: compressed, forKey: placeholderId)
            let base64 = compressed.base64EncodedString()
            let dataUrl = "data:image/jpeg;base64,\(base64)"
            await MainActor.run {
                viewModel.uploadAttachment(dataUrl: dataUrl, name: name, correlationId: correlationId)
            }
        }
    }

    private func handleDocumentPickerResult(_ result: Result<[URL], Error>) {
        guard case .success(let urls) = result else { return }
        for url in urls {
            guard url.startAccessingSecurityScopedResource() else { continue }
            defer { url.stopAccessingSecurityScopedResource() }
            let name = url.lastPathComponent
            guard let data = try? Data(contentsOf: url) else { continue }

            let placeholderId = UUID().uuidString
            let correlationId = UUID().uuidString
            let imageExts: Set = ["png", "jpg", "jpeg", "gif", "webp", "svg"]
            let ext = url.pathExtension.lowercased()
            let type = imageExts.contains(ext) ? "image" : "file"

            if type == "image" {
                // Upload image via data URL
                pendingAttachments.append(PendingAttachment(id: placeholderId, type: "image", name: name, path: "", isUploading: true, correlationId: correlationId))
                let compressed = compressImage(data: data, maxBytes: 1_000_000)
                AttachmentImageCache.shared.store(data: compressed, forKey: placeholderId)
                let base64 = compressed.base64EncodedString()
                let mimeExt = (ext == "jpg" || ext == "jpeg") ? "jpeg" : ext
                let dataUrl = "data:image/\(mimeExt);base64,\(base64)"
                viewModel.uploadAttachment(dataUrl: dataUrl, name: name, correlationId: correlationId)
            } else {
                // Upload non-image file via data URL so desktop can save it
                pendingAttachments.append(PendingAttachment(id: placeholderId, type: "file", name: name, path: "", isUploading: true, correlationId: correlationId))
                let base64 = data.base64EncodedString()
                let dataUrl = "data:application/octet-stream;base64,\(base64)"
                viewModel.uploadAttachment(dataUrl: dataUrl, name: name, correlationId: correlationId)
            }
        }
    }

    private func compressImage(data: Data, maxBytes: Int) -> Data {
        guard let uiImage = UIImage(data: data) else { return data }
        var quality: CGFloat = 0.8
        while quality > 0.1 {
            if let jpeg = uiImage.jpegData(compressionQuality: quality), jpeg.count <= maxBytes {
                return jpeg
            }
            quality -= 0.1
        }
        return uiImage.jpegData(compressionQuality: 0.1) ?? data
    }

    private func consumeUploadResults(_ results: [UploadAttachmentResult]) {
        guard !results.isEmpty else { return }
        var consumedIds = Set<String>()
        for result in results {
            guard let cid = result.correlationId, !cid.isEmpty else { continue }
            if let idx = pendingAttachments.firstIndex(where: { $0.isUploading && $0.correlationId == cid }) {
                consumedIds.insert(cid)
                if let error = result.error, !error.isEmpty {
                    pendingAttachments.remove(at: idx)
                } else {
                    AttachmentImageCache.shared.rekey(from: pendingAttachments[idx].id, to: result.id)
                    // Also key by the desktop-side path so rehydrated messages
                    // (which only know the path from the marker text) can find
                    // the same image bytes for inline rendering.
                    if pendingAttachments[idx].type == "image", !result.path.isEmpty,
                       let bytes = AttachmentImageCache.shared.data(forKey: result.id) {
                        AttachmentImageCache.shared.store(data: bytes, forKey: result.path)
                    }
                    pendingAttachments[idx] = PendingAttachment(
                        id: result.id, type: pendingAttachments[idx].type, name: result.name, path: result.path, isUploading: false, correlationId: cid
                    )
                }
            }
        }
        if !consumedIds.isEmpty {
            viewModel.pendingUploadResults.removeAll { r in
                guard let cid = r.correlationId else { return false }
                return consumedIds.contains(cid)
            }
        }
    }

    // MARK: - Slash commands

    private func updateSlashFilter(_ text: String) {
        let pattern = #"^\/[a-zA-Z0-9_:\-]*$"#
        if text.range(of: pattern, options: .regularExpression) != nil {
            slashFilter = text
        } else {
            slashFilter = nil
        }
    }

    private func fetchCommandsIfNeeded() {
        let dir = workingDirectory
        guard !dir.isEmpty, viewModel.discoveredCommands[dir] == nil else { return }
        viewModel.discoverCommands(directory: dir)
    }
}

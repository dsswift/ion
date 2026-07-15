import SwiftUI
import UIKit

// MARK: - ConversationView input bar, voice, and submit
//
// Extracted from the merged ConversationView (formerly EngineView) to keep the
// main view file under the Swift 600-line cap after the #256 view merge. These
// are the input-bar subview, the voice-recording controls, the attach button,
// and the send/scroll actions. They stay members of ConversationView via this
// extension so the call sites in `body` / `mainContent` are unchanged.

extension ConversationView {

    // MARK: - Abort gate

    /// Whether the stop button should be visible. Mirrors the desktop's
    /// `(isRunning || hasRunningChildren)` interrupt-button gate: the user
    /// must be able to abort while the orchestrator is running OR while
    /// dispatched background agents are still alive even though the
    /// orchestrator went idle. `hasRunningChildren` is projected by the
    /// desktop snapshot and aggregated across the tab's conversation
    /// instances, so this covers plain and extension-hosted conversations
    /// identically.
    var canAbort: Bool {
        ConversationView.computeCanAbort(
            status: viewModel.tab(for: tabId)?.status,
            hasRunningChildren: viewModel.tab(for: tabId)?.hasRunningChildren
        )
    }

    /// Pure, view-independent gate for the abort affordance. Extracted so
    /// the visibility logic is unit-testable without instantiating the view.
    /// Migrated from the dead InputBar.swift (see Fix 3 retirement commit).
    static func computeCanAbort(status: TabStatus?, hasRunningChildren: Bool?) -> Bool {
        let running = status == .running || status == .connecting
        return running || (hasRunningChildren == true)
    }

    // MARK: - Engine input bar

    var engineInputBar: some View {
        VStack(spacing: 0) {
            if let filter = slashFilter, !slashCommands.isEmpty {
                SlashCommandMenu(
                    filter: filter,
                    commands: slashCommands,
                    onSelect: { cmd in
                        viewModel.setEngineDraft(tabId: tabId, instanceId: activeInstanceId, "/\(cmd.name) ")
                        slashFilter = nil
                    }
                )
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }

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

                if canAbort {
                    Button {
                        DiagnosticLog.log("inputbar abort tapped", tag: "view.inputbar", fields: [
                            "tab_id": tabId,
                            "status": viewModel.tab(for: tabId)?.status.rawValue ?? "nil",
                            "reason": String(viewModel.tab(for: tabId)?.hasRunningChildren == true)
                        ])
                        viewModel.cancel(tabId: tabId)
                    } label: {
                        Image(systemName: "stop.circle.fill")
                            .font(.title2)
                            .foregroundStyle(.red)
                            .shadow(color: .red.opacity(0.3), radius: 6)
                    }
                    .accessibilityLabel("Stop")
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
        }
        .animation(IonTheme.snappySpring, value: slashFilter)
        .animation(IonTheme.snappySpring, value: isRecordingVoice)
        .animation(IonTheme.snappySpring, value: canAbort)
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
        .onChange(of: promptText) { _, newText in
            updateSlashFilter(newText)
        }
        .onChange(of: workingDirectory) {
            fetchCommandsIfNeeded()
        }
    }

    var engineMicButton: some View {
        Button {
            startVoiceRecording()
        } label: {
            Image(systemName: "mic.fill")
                .font(.title3)
                .foregroundStyle(engineMicButtonColor)
        }
        .accessibilityLabel("Record voice input")
    }

    var engineMicButtonColor: Color {
        return viewModel.speechService.permissionState == .denied ? Color(.quaternaryLabel) : .secondary
    }

    func startVoiceRecording() {
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
                DiagnosticLog.log("inputbar recording started", tag: "view.inputbar", fields: [
                    "reason": String(draftBeforeRecording.prefix(40))
                ])
            } catch {
                DiagnosticLog.log("inputbar start recording error", tag: "view.inputbar", level: .error, fields: [
                    "error": error.localizedDescription
                ])
                isRecordingVoice = false
            }
        }
    }

    func stopVoiceRecording() {
        DiagnosticLog.log("ENGINE-INPUTBAR: stopVoiceRecording — text already in field")
        viewModel.speechService.cancelRecording()
        isRecordingVoice = false
        Haptic.light()
    }

    func cancelVoiceRecording() {
        DiagnosticLog.log("ENGINE-INPUTBAR: cancelVoiceRecording — restoring draft snapshot")
        viewModel.speechService.cancelRecording()
        isRecordingVoice = false
        viewModel.setEngineDraft(tabId: tabId, instanceId: activeInstanceId, draftBeforeRecording)
        Haptic.light()
    }

    var attachButton: some View {
        Button {
            showAttachMenu = true
        } label: {
            Image(systemName: "paperclip")
                .font(.title3)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Actions

    var cannotSend: Bool {
        let empty = promptText.trimmingCharacters(in: .whitespaces).isEmpty
        return (empty && pendingAttachments.isEmpty) || hasUploading
    }

    /// Re-sync history when we recover from a transient disconnect
    /// (e.g. phone locked while the conversation was running). The snapshot
    /// handler also pre-loads history for unloaded tabs, but this handler
    /// arms `pendingScrollAfterReload` so the view auto-scrolls to the
    /// new bottom once history arrives.
    ///
    /// WI-004 / #259: loadConversation handles every tab.
    func handleConnectionStateChange(oldState: ConnectionState, newState: ConnectionState) {
        guard oldState == .reconnecting && newState == .connected else { return }
        // Only refresh tabs the user has actually opened; unopened tabs are
        // handled by the snapshot prefetch in handleSnapshot.
        guard !engineMsgs.isEmpty else { return }
        DiagnosticLog.log("resume sync reloading", tag: "view.inputbar", fields: [
            "tab_id": String(tabId.prefix(8))
        ])
        pendingScrollAfterReload = true
        viewModel.loadConversation(tabId: tabId)
        viewModel.requestLoadAttachments(tabId: tabId)
    }

    /// When a reconnect-triggered reload delivers new history, force-scroll
    /// to the bottom regardless of the user's prior scroll position.
    func consumePendingScrollAfterReload() {
        guard pendingScrollAfterReload else { return }
        pendingScrollAfterReload = false
        isNearBottom = true
        forceScrollCounter += 1
    }

    func submitPrompt() {
        let trimmed = promptText.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty || !pendingAttachments.isEmpty else { return }
        guard !hasUploading else { return }
        isNearBottom = true
        forceScrollCounter += 1
        Haptic.light()
        let attachments = pendingAttachments.map(\.commandAttachment)
        viewModel.submit(
            tabId: tabId,
            text: promptText,
            attachments: attachments.isEmpty ? nil : attachments
        )
        isInputFocused = false
        viewModel.setEngineDraft(tabId: tabId, instanceId: activeInstanceId, "")
        pendingAttachments = []
    }

    func contextBarColor(_ percent: Double) -> Color {
        if percent < 60 { return .green }
        if percent < 80 { return .orange }
        return .red
    }
}

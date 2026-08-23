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
            hasRunningChildren: viewModel.tab(for: tabId)?.hasRunningChildren,
            hasActiveBackgroundTasks: !activeBackgroundTasks.isEmpty
        )
    }

    /// Whether the orchestrator itself has an active run. Distinct from
    /// `canAbort`, which is also true when only background dispatches remain:
    /// in that state "stop the orchestrator" has nothing to stop.
    var orchestratorRunning: Bool {
        let status = viewModel.tab(for: tabId)?.status
        return status == .running || status == .connecting
    }

    /// Whether dispatched background agents are alive, for the menu wording.
    var hasRunningChildren: Bool {
        viewModel.tab(for: tabId)?.hasRunningChildren == true
    }

    func stopOrchestrator() {
        DiagnosticLog.log("inputbar stop orchestrator tapped", tag: "view.inputbar", fields: [
            "tab_id": tabId,
            "status": viewModel.tab(for: tabId)?.status.rawValue ?? "nil",
            "reason": String(hasRunningChildren)
        ])
        viewModel.cancel(tabId: tabId, scope: "orchestrator")
    }

    func stopAll() {
        DiagnosticLog.log("inputbar stop all tapped", tag: "view.inputbar", fields: [
            "tab_id": tabId,
            "status": viewModel.tab(for: tabId)?.status.rawValue ?? "nil",
            "reason": String(hasRunningChildren)
        ])
        viewModel.cancel(tabId: tabId, scope: "all_work")
    }

    /// Pure, view-independent gate for the abort affordance. Extracted so
    /// the visibility logic is unit-testable without instantiating the view.
    /// Migrated from the dead InputBar.swift (see Fix 3 retirement commit).
    static func computeCanAbort(
        status: TabStatus?,
        hasRunningChildren: Bool?,
        hasActiveBackgroundTasks: Bool = false
    ) -> Bool {
        let running = status == .running || status == .connecting || status == .waiting
        return running || (hasRunningChildren == true) || hasActiveBackgroundTasks
    }

    /// Whether the active conversation instance has an image-generation model
    /// selected. Image models (modelKind == "image") use a single-prompt API
    /// with no conversation history, so the input bar shows a disclosure hint.
    /// Mirrors the desktop's `isImageModel` check in `InputBar.tsx`.
    var isImageModel: Bool {
        let activeInst = viewModel.engineInstance(tabId: tabId, instanceId: activeInstanceId)
        let effectiveModelId = activeInst?.modelOverride ?? viewModel.preferredModel
        guard !effectiveModelId.isEmpty else { return false }
        return viewModel.availableModels.first(where: { $0.id == effectiveModelId })?.modelKind == "image"
    }

    /// Whether the image-model disclosure banner is visible. Gated on the user
    /// actively composing (input focused or a non-empty draft) so the banner
    /// informs the prompt being written instead of permanently occupying input-
    /// bar space while the user reads the conversation. Phone screens are far
    /// tighter than the desktop overlay, so unlike InputBar.tsx (always visible
    /// while an image model is selected) iOS shows it only when it is relevant.
    var showImageModelBanner: Bool {
        ConversationView.computeShowImageModelBanner(
            isImageModel: isImageModel,
            isInputFocused: isInputFocused,
            promptText: promptText
        )
    }

    /// Pure, view-independent gate for the image-model banner. Extracted so the
    /// visibility logic is unit-testable without instantiating the view (same
    /// pattern as computeCanAbort above).
    static func computeShowImageModelBanner(isImageModel: Bool, isInputFocused: Bool, promptText: String) -> Bool {
        isImageModel && (isInputFocused || !promptText.isEmpty)
    }

    // MARK: - Engine input bar

    /// Whether this tab's conversation is input-locked (an auto-generated
    /// conflict-fix conversation). Mirrors the desktop InputBar: the input
    /// surface is replaced with a static notice, because the tab's entire
    /// instruction is the one machine-sent prompt and follow-ups are refused
    /// by the desktop's submit guard anyway. Reads the snapshot field, so the
    /// phone and the desktop agree from the first frame.
    var isInputLocked: Bool {
        viewModel.tab(for: tabId)?.inputLocked == true
    }

    /// Current capacity telemetry for the active conversation. This drives status
    /// display only. The engine owns prompt admission and automatic compaction.
    var contextCapacity: ConversationStatusBar.ContextCapacity? {
        let instance = viewModel.engineInstance(tabId: tabId, instanceId: activeInstanceId)
        let fieldsTokens = instance?.statusFields?.contextTokens
        let occupancy = (fieldsTokens ?? 0) > 0 ? fieldsTokens : viewModel.tab(for: tabId)?.contextTokens
        let modelId = instance?.modelOverride ?? viewModel.tab(for: tabId)?.modelOverride ?? viewModel.preferredModel
        let engineWindow = instance?.statusFields?.contextWindow
        let fallbackWindow = (engineWindow ?? 0) > 0 ? engineWindow : viewModel.tab(for: tabId)?.contextWindow
        return ConversationStatusBar.resolveContextCapacity(
            occupancyTokens: occupancy,
            modelId: modelId,
            availableModels: viewModel.availableModels,
            engineContextWindow: fallbackWindow,
            engineEffectiveLimit: instance?.statusFields?.contextEffectiveLimit,
        )
    }

    var contextCapacityState: ConversationStatusBar.ContextCapacityState {
        ConversationStatusBar.contextCapacityState(contextCapacity)
    }

    @ViewBuilder
    var engineInputBar: some View {
        if isInputLocked {
            if viewModel.tab(for: tabId)?.inputLockReason == "settled" {
                if viewModel.tab(for: tabId)?.canRestoreSettled == false {
                    permanentlySettledInputNotice
                } else {
                    settledInputNotice
                }
            } else {
                HStack(spacing: 6) {
                    Image(systemName: "lock")
                        .font(.system(size: 10)) // design-type: SF Symbol lock glyph sized as icon geometry, not text
                        .foregroundStyle(.tertiary)
                    Text(viewModel.tab(for: tabId)?.inputLockReason == "landed-worktree"
                        ? "Landed worktree review — input is disabled. Retire this worktree when review is complete."
                        : "Automated fix conversation — input is disabled. Continue the work in its worktree.")
                        .ionType(.microLabel)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                    Spacer()
                }
                .padding(.horizontal, 14) // design-geometry: 14pt gap between contentGap and rowInset; off the 4pt ratio scale
                .padding(.vertical, IonSpace.contentGap)
                .accessibilityIdentifier("input-locked-notice")
            }
        } else {
            engineInputBarUnlocked
        }
    }

    private var permanentlySettledInputNotice: some View {
        HStack(spacing: 6) {
            Image(systemName: "archivebox")
                .font(.system(size: 10)) // design-type: SF Symbol glyph sized as icon geometry, not text
                .foregroundStyle(.tertiary)
            Text("Settled history — its worktree was retired.")
                .ionType(.microLabel)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer()
        }
        .padding(.horizontal, 14) // design-geometry: 14pt gap between contentGap and rowInset; off the 4pt ratio scale
        .padding(.vertical, IonSpace.contentGap)
        .accessibilityIdentifier("permanently-settled-input-notice")
    }

    /// Settled conversation notice with an Un-settle action. This notice is used
    /// only while the desktop says the record can restore. A retired-worktree
    /// record uses the permanent notice above.
    private var settledInputNotice: some View {
        HStack(spacing: 6) {
            Image(systemName: "archivebox")
                .font(.system(size: 10)) // design-type: SF Symbol glyph sized as icon geometry, not text
                .foregroundStyle(.tertiary)
            Text("Settled — input is paused.")
                .ionType(.microLabel)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer()
            Button {
                viewModel.unsettleTab(tabId: tabId)
            } label: {
                Text("Un-settle")
                    .ionType(.microLabel)
                    .foregroundStyle(theme.accent)
            }
            .accessibilityIdentifier("unsettle-button")
        }
        .padding(.horizontal, 14) // design-geometry: 14pt gap between contentGap and rowInset; off the 4pt ratio scale
        .padding(.vertical, IonSpace.contentGap)
        .accessibilityIdentifier("settled-input-notice")
    }

    private var engineInputBarUnlocked: some View {
        VStack(spacing: 0) {
            if contextCapacityState != .normal {
                contextCapacityWarning
            }

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

            // Image model disclosure banner — shown while the user is composing
            // with an image-generation model selected (showImageModelBanner:
            // focused or non-empty draft). Informs the user that only the
            // current message is sent (no conversation history). Compact single
            // line so it never dominates the input bar on a phone screen.
            if showImageModelBanner {
                HStack(spacing: 4) {
                    Image(systemName: "photo")
                        .font(.system(size: 9)) // design-type: SF Symbol photo glyph sized as icon geometry, not text
                        .foregroundStyle(.tertiary)
                    Text("Image model — only this message is sent")
                        .ionType(.microLabel)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                    Spacer()
                }
                .padding(.horizontal, 14) // design-geometry: 14pt gap between contentGap and rowInset; off the 4pt ratio scale
                .padding(.top, IonSpace.hairlineGap)
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            }

            HStack(spacing: 8) {
                attachButton
                TextField("Send a prompt...", text: promptTextBinding, axis: .vertical)
                    .lineLimit(1...5)
                    .padding(.horizontal, IonSpace.contentGap)
                    .padding(.vertical, IonSpace.compactGap)
                    .background(theme.surfaceSecondary)
                    .clipShape(RoundedRectangle(cornerRadius: IonTheme.Radius.medium))
                    .overlay(RoundedRectangle(cornerRadius: IonTheme.Radius.medium).stroke(
                        isRecordingVoice ? theme.accent.opacity(0.5) : theme.borderSubtle,
                        lineWidth: isRecordingVoice ? 1.5 : 1
                    ))
                    .focused($isInputFocused)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()

                // Abort is hidden while voice recording is active: the
                // recording strip's own stop/cancel controls occupy this
                // area, and the abort button materializing next to them
                // mid-interaction shifted the layout so a tap aimed at the
                // strip landed on abort and killed the running turn (the
                // "response terminated after three characters" incident).
                // Abort reappears as soon as recording ends.
                if canAbort && !isRecordingVoice {
                    // A Menu rather than a plain Button: stopping the
                    // orchestrator and stopping the whole tree are different
                    // decisions, and the destructive one must not be the
                    // default target of a tap aimed at "stop". Mirrors the
                    // desktop's split Stop control.
                    Menu {
                        Button {
                            stopOrchestrator()
                        } label: {
                            Label(hasRunningChildren
                                  ? "Stop orchestrator (keep agents)"
                                  : "Stop orchestrator",
                                  systemImage: "stop.circle")
                        }
                        .disabled(!orchestratorRunning)

                        Button(role: .destructive) {
                            stopAll()
                        } label: {
                            Label("Stop all", systemImage: "stop.fill")
                        }
                    } label: {
                        Image(systemName: "stop.fill")
                            .font(IonType.metadata)
                            .foregroundStyle(theme.statusError)
                            .frame(width: IonSpace.screenInset, height: IonSpace.screenInset)
                            .overlay(Circle().stroke(theme.statusError, lineWidth: 1))
                    } primaryAction: {
                        // A plain tap takes the recoverable action; the menu is
                        // a long-press away for Stop all.
                        if orchestratorRunning { stopOrchestrator() } else { stopAll() }
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
                        .foregroundStyle(!cannotSend ? theme.accent : theme.textTertiary)
                }
                .disabled(cannotSend)
            }
            .padding(.horizontal, IonSpace.contentGap)
            .padding(.vertical, IonSpace.compactGap)
        }
        .animation(IonTheme.snappySpring, value: slashFilter)
        .animation(IonTheme.snappySpring, value: isRecordingVoice)
        .animation(IonTheme.snappySpring, value: canAbort)
        .animation(.easeInOut(duration: 0.15), value: showImageModelBanner)
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

    private var contextCapacityWarning: some View {
        HStack(spacing: 4) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 9)) // design-type: SF Symbol warning glyph sized as icon geometry, not text
                .foregroundStyle(theme.statusWarning)
            Text(contextCapacityState == .full
                ? "Context is full — the engine will compact automatically when enabled"
                : "Context is \(Int(contextCapacity?.percent ?? 0))% full")
                .ionType(.microLabel)
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(.horizontal, 14) // design-geometry: 14pt gap between contentGap and rowInset; off the 4pt ratio scale
        .padding(.top, IonSpace.hairlineGap)
        .accessibilityIdentifier("context-capacity-warning")
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
        ConversationView.computeCannotSend(
            promptText: promptText,
            attachmentCount: pendingAttachments.count,
            hasUploading: hasUploading,
            contextCapacityState: contextCapacityState
        )
    }

    /// Pure submit-button gate. Context capacity is accepted for an explicit
    /// contract check but does not block: the engine owns admission and can run
    /// automatic compaction before its provider request.
    static func computeCannotSend(
        promptText: String,
        attachmentCount: Int,
        hasUploading: Bool,
        contextCapacityState _: ConversationStatusBar.ContextCapacityState
    ) -> Bool {
        let empty = promptText.trimmingCharacters(in: .whitespaces).isEmpty
        return (empty && attachmentCount == 0) || hasUploading
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
        // Submitting while a voice recording is active: the transcript is
        // already in the field (live transcription writes into the draft), so
        // whatever was being transcribed is what is being sent. Stop the
        // recording WITHOUT restoring the pre-recording draft snapshot
        // (cancelVoiceRecording would clobber promptText before the send).
        if isRecordingVoice {
            viewModel.speechService.cancelRecording()
            isRecordingVoice = false
        }
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

}

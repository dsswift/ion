import SwiftUI

// MARK: - ConversationView composer
//
// The composer pill: the message field on top, the controls row beneath it.
// The controls row carries attach, the conversation controls
// (ConversationStatusBar: model, mode, thinking, context ring), stop while a
// turn runs, and the trailing slot (mic, send, or the dictation pair).
//
// While a dictation session is open the row changes shape: attach becomes
// Cancel, the conversation controls give way to the listening strip, and the
// trailing slot shows Done beside Send. The field keeps showing the live
// words throughout, so what the operator sees is what Done keeps and what
// Send sends.
//
// Split from ConversationView+InputBar.swift, which keeps the gates, the
// locked-input notices, and the submit action.

extension ConversationView {

    // MARK: - Dictation state (read from the service; the view owns none)

    var dictationPhase: SpeechRecognitionService.DictationPhase {
        viewModel.speechService.phase
    }

    var isDictating: Bool {
        viewModel.speechService.isDictating
    }

    var trailingControl: ComposerTrailingControl {
        ComposerTrailingControl.resolve(
            isDictating: isDictating,
            hasText: !promptText.trimmingCharacters(in: .whitespaces).isEmpty,
            hasAttachments: !pendingAttachments.isEmpty
        )
    }

    // MARK: - Pill

    var composerPill: some View {
        VStack(alignment: .leading, spacing: IonSpace.compactGap) {
            if !pendingAttachments.isEmpty {
                AttachmentChipsView(attachments: pendingAttachments) { id in
                    pendingAttachments.removeAll { $0.id == id }
                }
            }

            TextField(ComposerTrailingControl.placeholder(for: dictationPhase), text: promptTextBinding, axis: .vertical)
                .font(IonType.body)
                .lineLimit(1...6)
                .focused($isInputFocused)
                .textInputAutocapitalization(.sentences)
                .disabled(isDictating)
                .padding(.horizontal, IonSpace.hairlineGap)
                .accessibilityIdentifier("composer-field")

            composerControlsRow
        }
        .padding(.horizontal, IonSpace.contentGap)
        .padding(.top, IonSpace.contentGap)
        .padding(.bottom, IonSpace.compactGap)
        .background(theme.surfaceElevated)
        .clipShape(RoundedRectangle(cornerRadius: IonRadius.sheet))
        .overlay(
            RoundedRectangle(cornerRadius: IonRadius.sheet)
                .stroke(isDictating ? theme.accent.opacity(0.6) : theme.borderSubtle, lineWidth: isDictating ? 1.5 : 1)
        )
        .padding(.horizontal, IonSpace.contentGap)
        .padding(.bottom, IonSpace.compactGap)
        .animation(IonTheme.snappySpring, value: dictationPhase)
        .animation(IonTheme.snappySpring, value: trailingControl)
        .animation(IonTheme.snappySpring, value: canAbort)
        .onChange(of: viewModel.speechService.transcript) { _, _ in
            viewModel.syncDictationDraft(tabId: tabId)
        }
        .onChange(of: viewModel.speechService.isRecording) { _, recording in
            if !recording { viewModel.dictationEngineEnded(tabId: tabId) }
        }
        .onDisappear {
            // Leaving the conversation mid-dictation keeps the words: the
            // session is finished into this tab's draft rather than left
            // listening against a composer nobody is looking at.
            if isDictating {
                Task { await viewModel.finishDictation(tabId: tabId) }
            }
        }
    }

    // MARK: - Controls row

    @ViewBuilder
    private var composerControlsRow: some View {
        HStack(spacing: IonSpace.compactGap) {
            if isDictating {
                dictationCancelButton
                DictationStrip(
                    audioLevel: viewModel.speechService.audioLevel,
                    startedAt: viewModel.speechService.startedAt,
                    isFinishing: dictationPhase == .finishing
                )
                Spacer(minLength: 0)
                dictationDoneButton
                sendButton
            } else {
                attachButton
                conversationControls
                if canAbort {
                    stopButton
                }
                if trailingControl.showsMicrophone {
                    micButton
                }
                if trailingControl == .send {
                    sendButton
                }
            }
        }
    }

    private var conversationControls: some View {
        let activeInst = viewModel.engineInstance(tabId: tabId, instanceId: activeInstanceId)
        let engineInputs = ConversationStatusBar.resolveEngineInputs(
            fields: activeInst?.statusFields,
            fallbackPreferredModel: viewModel.resolvedModel(tabId: tabId, instanceId: activeInstanceId),
        )
        return ConversationStatusBar(
            modelOverride: activeInst?.modelOverride,
            preferredModel: engineInputs.preferredModel,
            contextPercent: engineInputs.contextPercent,
            contextTokens: engineInputs.contextTokens,
            engineContextWindow: engineInputs.engineContextWindow,
            // The last real turn, which is what wrote the prompt cache the
            // model-switch estimate prices against.
            lastTurnAtMs: viewModel.tab(for: tabId)?.lastMessageAt,
            isRunning: isRunning,
            permissionMode: viewModel.tab(for: tabId)?.permissionMode,
            availableModels: viewModel.availableModels,
            onSelectModel: { model, providerId in
                viewModel.setModel(tabId: tabId, model: model, providerId: providerId)
            },
            onToggleMode: {
                guard let current = viewModel.tab(for: tabId)?.permissionMode else { return }
                let newMode: PermissionMode = current == .plan ? .auto : .plan
                viewModel.setPermissionMode(tabId: tabId, mode: newMode)
            },
            onTapContextIndicator: {
                showStatusDrawer = true
            },
            hasEngineExtension: tabHasExtensions,
            thinkingEffort: activeInst?.thinkingEffort ?? "off",
            onSelectThinkingEffort: { level in
                viewModel.setThinkingEffort(tabId: tabId, effort: level)
            }
        )
    }

    // MARK: - Buttons

    /// Every control in the row is a `ComposerControlSize` square so the
    /// row's height never changes as controls swap in and out.
    private static let controlSize: CGFloat = IonSpace.screenInset

    var attachButton: some View {
        Button {
            showAttachMenu = true
        } label: {
            Image(systemName: "plus")
                .font(IonType.rowTitle)
                .foregroundStyle(theme.textSecondary)
                .frame(width: Self.controlSize, height: Self.controlSize)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Attach")
    }

    var micButton: some View {
        Button {
            startDictation()
        } label: {
            Image(systemName: "mic")
                .font(IonType.rowTitle)
                .foregroundStyle(viewModel.speechService.permissionState == .denied ? theme.textTertiary : theme.textSecondary)
                .frame(width: Self.controlSize, height: Self.controlSize)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Dictate")
    }

    var sendButton: some View {
        Button { submitPrompt() } label: {
            Image(systemName: "arrow.up")
                .font(IonType.bodyStrong)
                .foregroundStyle(theme.background)
                .frame(width: Self.controlSize, height: Self.controlSize)
                .background(Circle().fill(cannotSend ? theme.textTertiary : theme.accent))
        }
        .buttonStyle(.plain)
        .disabled(cannotSend)
        .accessibilityLabel("Send")
    }

    /// A Menu rather than a plain Button: stopping the orchestrator and
    /// stopping the whole tree are different decisions, and the destructive
    /// one must not be the default target of a tap aimed at "stop". Mirrors
    /// the desktop's split Stop control. A plain tap takes the recoverable
    /// action; the menu is a long-press away for Stop all.
    var stopButton: some View {
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
                .frame(width: Self.controlSize, height: Self.controlSize)
                .background(Circle().fill(theme.statusError.opacity(0.15)))
        } primaryAction: {
            if orchestratorRunning { stopOrchestrator() } else { stopAll() }
        }
        .accessibilityLabel("Stop")
    }

    private var dictationCancelButton: some View {
        Button {
            cancelDictation()
        } label: {
            Image(systemName: "xmark")
                .font(IonType.bodyStrong)
                .foregroundStyle(theme.textSecondary)
                .frame(width: Self.controlSize, height: Self.controlSize)
                .background(Circle().fill(theme.surfaceSecondary))
        }
        .buttonStyle(.plain)
        .disabled(dictationPhase == .finishing)
        .accessibilityLabel("Cancel dictation")
    }

    private var dictationDoneButton: some View {
        Button {
            finishDictation()
        } label: {
            Image(systemName: "checkmark")
                .font(IonType.bodyStrong)
                .foregroundStyle(theme.accent)
                .frame(width: Self.controlSize, height: Self.controlSize)
                .background(Circle().stroke(theme.accent, lineWidth: 1.5))
        }
        .buttonStyle(.plain)
        .disabled(dictationPhase == .finishing)
        .accessibilityLabel("Done, keep dictated text")
    }

    // MARK: - Dictation actions

    func startDictation() {
        DiagnosticLog.log("composer dictation tapped", tag: "view.composer", fields: [
            "tab_id": String(tabId.prefix(8)),
            "draft_count": String(promptText.count)
        ])
        Haptic.light()
        isInputFocused = false
        Task {
            switch await viewModel.startDictation(tabId: tabId) {
            case .started:
                break
            case .permissionDenied:
                showPermissionDeniedAlert = true
            case .failed(let message):
                viewModel.showToast(ToastMessage(style: .error, title: "Couldn't start dictation", detail: message))
            }
        }
    }

    func finishDictation() {
        DiagnosticLog.log("composer dictation done tapped", tag: "view.composer", fields: [
            "tab_id": String(tabId.prefix(8))
        ])
        Haptic.light()
        Task { await viewModel.finishDictation(tabId: tabId) }
    }

    func cancelDictation() {
        DiagnosticLog.log("composer dictation cancel tapped", tag: "view.composer", fields: [
            "tab_id": String(tabId.prefix(8))
        ])
        Haptic.light()
        viewModel.cancelDictation(tabId: tabId)
    }
}

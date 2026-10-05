import SwiftUI
import UIKit

// MARK: - ConversationView input bar: gates, notices, and submit
//
// The input bar is the composer pill (ConversationView+Composer.swift) plus
// what sits around it: the capacity warning, the slash-command menu, the
// image-model disclosure, and the locked-input notices that replace the pill
// when a conversation accepts no more prompts. The gates that decide what the
// composer may do (abort, send, banner) and the submit action itself live
// here, as pure functions where the logic is worth pinning in a test.

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
        let effectiveModelId = activeInst?.modelOverride ?? viewModel.resolvedModel(tabId: tabId, instanceId: activeInstanceId)
        guard !effectiveModelId.isEmpty else { return false }
        return ModelCatalog.entry(for: effectiveModelId, in: viewModel.availableModels)?.modelKind == "image"
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

    // MARK: - Input bar

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
        let modelId = instance?.modelOverride ?? viewModel.tab(for: tabId)?.modelOverride ?? viewModel.resolvedModel(tabId: tabId, instanceId: activeInstanceId)
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
                inputNotice(
                    systemImage: "lock",
                    text: viewModel.tab(for: tabId)?.inputLockReason == "landed-worktree"
                        ? "Landed worktree review — input is disabled. Retire this worktree when review is complete."
                        : "Automated fix conversation — input is disabled. Continue the work in its worktree.",
                    lineLimit: 2
                )
                .accessibilityIdentifier("input-locked-notice")
            }
        } else {
            engineInputBarUnlocked
        }
    }

    private var permanentlySettledInputNotice: some View {
        inputNotice(systemImage: "archivebox", text: "Settled history — its worktree was retired.", lineLimit: 1)
            .accessibilityIdentifier("permanently-settled-input-notice")
    }

    /// Settled conversation notice with an Un-settle action. This notice is used
    /// only while the desktop says the record can restore. A retired-worktree
    /// record uses the permanent notice above.
    private var settledInputNotice: some View {
        inputNotice(systemImage: "archivebox", text: "Settled — input is paused.", lineLimit: 1) {
            Button {
                viewModel.unsettleTab(tabId: tabId)
            } label: {
                Text("Un-settle")
                    .ionType(.microLabel)
                    .foregroundStyle(theme.accent)
            }
            .accessibilityIdentifier("unsettle-button")
        }
        .accessibilityIdentifier("settled-input-notice")
    }

    /// A locked-input notice with no trailing action.
    private func inputNotice(systemImage: String, text: String, lineLimit: Int) -> some View {
        inputNotice(systemImage: systemImage, text: text, lineLimit: lineLimit) { EmptyView() }
    }

    /// The one shape every locked-input notice takes: a quiet glyph, one or
    /// two lines of explanation, and an optional trailing action.
    private func inputNotice<Trailing: View>(
        systemImage: String,
        text: String,
        lineLimit: Int,
        @ViewBuilder trailing: () -> Trailing
    ) -> some View {
        HStack(spacing: IonSpace.compactInset) {
            Image(systemName: systemImage)
                .font(IonType.microLabel)
                .foregroundStyle(theme.textTertiary)
            Text(text)
                .ionType(.microLabel)
                .foregroundStyle(theme.textSecondary)
                .lineLimit(lineLimit)
            Spacer()
            trailing()
        }
        .padding(.horizontal, IonSpace.rowInset)
        .padding(.vertical, IonSpace.contentGap)
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

            // Image model disclosure — shown while the user is composing with an
            // image-generation model selected (showImageModelBanner: focused or
            // non-empty draft). Informs the user that only the current message
            // is sent (no conversation history). Compact single line so it never
            // dominates the input bar on a phone screen.
            if showImageModelBanner {
                HStack(spacing: IonSpace.hairlineGap) {
                    Image(systemName: "photo")
                        .font(IonType.microLabel)
                        .foregroundStyle(theme.textTertiary)
                    Text("Image model — only this message is sent")
                        .ionType(.microLabel)
                        .foregroundStyle(theme.textTertiary)
                        .lineLimit(1)
                    Spacer()
                }
                .padding(.horizontal, IonSpace.rowInset)
                .padding(.bottom, IonSpace.compactInset)
                .transition(.opacity.combined(with: .move(edge: .bottom)))
            }

            composerPill
        }
        .animation(IonTheme.snappySpring, value: slashFilter)
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
        .onChange(of: promptText) { _, newText in
            updateSlashFilter(newText)
        }
        .onChange(of: workingDirectory) {
            fetchCommandsIfNeeded()
        }
    }

    private var contextCapacityWarning: some View {
        HStack(spacing: IonSpace.hairlineGap) {
            Image(systemName: "exclamationmark.triangle")
                .font(IonType.microLabel)
                .foregroundStyle(theme.statusWarning)
            Text(contextCapacityState == .full
                ? "Context is full — the engine will compact automatically when enabled"
                : "Context is \(Int(contextCapacity?.percent ?? 0))% full")
                .ionType(.microLabel)
                .foregroundStyle(theme.textSecondary)
            Spacer()
        }
        .padding(.horizontal, IonSpace.rowInset)
        .padding(.bottom, IonSpace.compactInset)
        .accessibilityIdentifier("context-capacity-warning")
    }

    // MARK: - Actions

    /// Whether the engine is compacting this tab's conversation. Mirrors the
    /// desktop InputBar's `isCompacting` gate: there is no way to steer a
    /// compaction in progress, so the send button disables the same way it
    /// does for `isInputLocked`, and `SessionViewModel.submit` refuses the
    /// attempt too. Reads the snapshot field, so the phone and the desktop
    /// agree from the first frame.
    var isCompactingTab: Bool {
        viewModel.tab(for: tabId)?.isCompacting == true
    }

    var cannotSend: Bool {
        ConversationView.computeCannotSend(
            promptText: promptText,
            attachmentCount: pendingAttachments.count,
            hasUploading: hasUploading,
            contextCapacityState: contextCapacityState,
            isCompacting: isCompactingTab
        )
    }

    /// Pure submit-button gate. Context capacity is accepted for an explicit
    /// contract check but does not block: the engine owns admission and can run
    /// automatic compaction before its provider request. `isCompacting` DOES
    /// block: unlike context pressure, a compaction in progress cannot be
    /// steered by sending, so queuing behind it would only mislead the user.
    static func computeCannotSend(
        promptText: String,
        attachmentCount: Int,
        hasUploading: Bool,
        contextCapacityState _: ConversationStatusBar.ContextCapacityState,
        isCompacting: Bool = false
    ) -> Bool {
        let empty = promptText.trimmingCharacters(in: .whitespaces).isEmpty
        return (empty && attachmentCount == 0) || hasUploading || isCompacting
    }

    /// Recovering from a transient disconnect (e.g. phone locked while the
    /// conversation was running). The view model re-fetches every transcript
    /// on reconnect; this arms `pendingScrollAfterReload` so the view scrolls
    /// to the new bottom when it lands, and refreshes the attachments.
    func handleConnectionStateChange(oldState: ConnectionState, newState: ConnectionState) {
        guard oldState == .reconnecting && newState == .connected else { return }
        guard !engineMsgs.isEmpty else { return }
        DiagnosticLog.log("resume sync reloading", tag: "view.inputbar", fields: [
            "tab_id": String(tabId.prefix(8))
        ])
        pendingScrollAfterReload = true
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

    /// `thenNew` is a background send: once sent, the phone opens a fresh
    /// conversation like this one (same project, profile, and worktree
    /// choice), so the next task can be typed while this one runs.
    func submitPrompt(skipClearConfirm: Bool = false, thenNew: Bool = false) {
        // Sending while dictating: finish the session first so the recognizer
        // commits the words it is still holding, then send what the draft
        // actually says. Sending the field at the instant of the tap shipped
        // the recognizer's last guess and dropped its final correction.
        if isDictating {
            DiagnosticLog.log("submit while dictating; finishing first", tag: "view.inputbar", fields: [
                "tab_id": String(tabId.prefix(8))
            ])
            Task {
                await viewModel.finishDictation(tabId: tabId)
                submitPrompt(skipClearConfirm: skipClearConfirm, thenNew: thenNew)
            }
            return
        }
        let trimmed = promptText.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty || !pendingAttachments.isEmpty else { return }
        guard !hasUploading else { return }
        // A command that clears the conversation is destructive from the
        // operator's seat: they typed a command and their history goes away. The
        // engine does the clear unconditionally and never asks (it does not
        // block for user input), so the confirmation has to happen here, before
        // the prompt is sent. ClearingCommand.resolve returns nil whenever there
        // is nothing to lose or anything is uncertain — see its doc comment on
        // failing open.
        if !skipClearConfirm {
            let tokens = viewModel.tab(for: tabId)?.contextTokens ?? 0
            if let clearing = ClearingCommand.resolve(
                input: trimmed,
                hasHistory: tokens > 0,
                commands: viewModel.discoveredCommands[workingDirectory] ?? []
            ) {
                DiagnosticLog.log(
                    "clearing command: confirming before send",
                    tag: "session",
                    level: .info,
                    fields: ["command": clearing.command]
                )
                pendingClearingCommand = clearing
                return
            }
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
        if thenNew { openSiblingConversation() }
    }

    /// Opens a fresh conversation in the same project as this one, with the
    /// same profile, cutting a new worktree from the same branch when this
    /// one lives in a worktree.
    func openSiblingConversation() {
        guard let tab = viewModel.tab(for: tabId) else { return }
        let directory = tab.worktree?.repoPath ?? tab.workingDirectory
        DiagnosticLog.log("background send: opening a fresh conversation", tag: "view.inputbar", fields: [
            "tab_id": String(tabId.prefix(8)), "in_worktree": String(tab.worktree != nil)
        ])
        viewModel.createTab(
            workingDirectory: directory,
            profileId: tab.engineProfileId,
            useWorktree: tab.worktree != nil ? true : nil,
            sourceBranch: tab.worktree?.sourceBranch
        )
    }

    /// Hands the draft to the server to hold until the conversation's account
    /// has weekly quota about to reset unused. The server sends it by itself.
    func queueDraftForSpareQuota() {
        let trimmed = promptText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        Haptic.light()
        viewModel.queueForSpareQuota(tabId: tabId, text: trimmed)
        isInputFocused = false
        viewModel.setEngineDraft(tabId: tabId, instanceId: activeInstanceId, "")
    }

}

import SwiftUI

/// Single-line status bar for conversation tabs showing model picker,
/// permission mode toggle, and context usage.
/// Also used for engine tabs when `hasEngineExtension` is true.
struct ConversationStatusBar: View {
    @Environment(\.appTheme) private var theme
    let modelOverride: String?
    let preferredModel: String
    let contextPercent: Double?
    let contextTokens: Int?
    /// Engine-reported context window size (tokens) of the model the engine
    /// used on the most recent turn. Mirrors RemoteTabState.contextWindow.
    /// When non-nil, resolvedContextPercent's fallback uses this value as
    /// the denominator instead of the picker-selected model's nominal
    /// window. The two diverge whenever the user changes the picker
    /// between turns (e.g. opus-running session displayed under Sonnet
    /// picker selection); honoring the engine's truth prevents the
    /// 100% / 498k / 200k display bug fixed in plan cosy-pacing-bee.md.
    let engineContextWindow: Int?
    let isRunning: Bool
    let permissionMode: PermissionMode?
    let availableModels: [RemoteModelEntry]
    let attachmentCount: Int
    let onSelectModel: (String) -> Void
    let onToggleMode: () -> Void
    let onTapAttachments: () -> Void
    var onTapContextIndicator: () -> Void = {}

    // Engine-specific optional parameters
    var hasEngineExtension: Bool = false
    var extensionName: String? = nil
    /// Number of dispatched agents currently running. When
    /// `isRunning` is false and this is > 0 the bar renders the yellow
    /// "waiting for N agent(s)" pulse + label (see
    /// `resolveRunActivity`). Mirrors the desktop's `agentRunningCount`.
    /// Defaults to 0 for older snapshots that don't carry the field.
    var runningAgentCount: Int = 0
    /// Background bash commands (Bash run_in_background +
    /// notify_on_complete) this instance is waiting on. The shell
    /// counterpart to `runningAgentCount`, ranked below it — matches
    /// `EngineInstanceBar`'s cascade and the desktop's
    /// `useActiveEngineBackgroundShellCount`. Defaults to 0 for older
    /// snapshots that don't carry the field.
    var runningShellCount: Int = 0

    // Extended-thinking (per-conversation). Think menu always renders beside
    // permission toggle. It disables when active model has no selectable effort
    // levels, preserving layout and explaining unavailable capability. The
    // neutral entry is Adaptive for self-regulating models, Off otherwise.
    // Level is isolated per conversation/subtab and applied on next prompt.
    var thinkingEffort: String = "off"
    var onSelectThinkingEffort: (String) -> Void = { _ in }

    @State private var showModeConfirm = false
    @State private var showModelPicker = false
    /// A model switch the operator chose but has not paid for yet. Held until
    /// they accept the prompt-cache re-write cost; nil when nothing is pending.
    @State private var pendingModelSwitch: (model: String, estimate: ModelSwitchCost.Estimate)?

    /// Engine-derived inputs for the status bar, resolved nil-safely from an
    /// optional `StatusFields`. The bar must ALWAYS render for engine tabs (like
    /// it does for plain conversations); when an engine instance has no status
    /// yet, these fall back to safe values so the core controls (model picker,
    /// permission toggle, attachments) stay visible and the status-dependent
    /// chrome (status dot, extension name) self-hides; context radial remains
    /// mounted at neutral 0% until occupancy becomes available.
    struct EngineInputs: Equatable {
        let preferredModel: String
        let contextPercent: Double?
        let contextTokens: Int?
        let engineContextWindow: Int?
        let extensionName: String?
    }

    /// Resolve `EngineInputs` from an optional `StatusFields` and the global
    /// preferred-model fallback. Pure — pinned by ConversationStatusBarVisibilityTests
    /// so the "always render, degrade gracefully" contract cannot regress back to
    /// gating the whole bar on `statusFields != nil`.
    static func resolveEngineInputs(
        fields: StatusFields?,
        fallbackPreferredModel: String,
    ) -> EngineInputs {
        EngineInputs(
            preferredModel: fields?.model ?? fallbackPreferredModel,
            contextPercent: fields?.contextPercent,
            contextTokens: fields?.contextTokens,
            engineContextWindow: (fields?.contextWindow ?? 0) > 0 ? fields?.contextWindow : nil,
            extensionName: fields?.extensionName,
        )
    }

    /// Run-activity indicator decision for the status-bar dot + label.
    ///
    /// Derived from the signals reliably present in the iOS view layer —
    /// `isRunning` (orchestrator run-state, which `ConversationView` derives
    /// from `tab.status`), `runningAgentCount` (dispatched agents), and
    /// `runningShellCount` (outstanding background bash commands). It does
    /// NOT read `StatusFields.state`: that field is non-Codable and
    /// snapshot-excluded on iOS, so gating the dot on it hid the yellow
    /// "waiting for N agent(s)" label whenever the orchestrator went idle
    /// with a child still running.
    ///
    /// Priority cascade keeps the foreground color when the orchestrator runs,
    /// but its label also includes any concurrent background-shell count. An
    /// idle orchestrator shows agents before shells. When no work applies,
    /// `show` is false and the bar renders no dot or label.
    struct RunActivity: Equatable {
        let show: Bool
        let isRunning: Bool
        let isWaitingShells: Bool
        let label: String
    }

    static func resolveRunActivity(isRunning: Bool, runningAgentCount: Int, runningShellCount: Int = 0) -> RunActivity {
        if isRunning {
            let shellSuffix = runningShellCount == 1 ? "" : "s"
            let label = runningShellCount > 0
                ? "running · \(runningShellCount) background shell\(shellSuffix)"
                : "running"
            return RunActivity(show: true, isRunning: true, isWaitingShells: false, label: label)
        }
        if runningAgentCount > 0 {
            let suffix = runningAgentCount == 1 ? "" : "s"
            return RunActivity(
                show: true,
                isRunning: false,
                isWaitingShells: false,
                label: "waiting for \(runningAgentCount) agent\(suffix)",
            )
        }
        // Background shells rank below agents, matching EngineInstanceBar's
        // statusIndicator cascade and the desktop's isWaitingShells check:
        // when both are outstanding the richer agent signal wins.
        if runningShellCount > 0 {
            let suffix = runningShellCount == 1 ? "" : "s"
            return RunActivity(
                show: true,
                isRunning: false,
                isWaitingShells: true,
                label: "waiting for \(runningShellCount) background shell\(suffix)",
            )
        }
        return RunActivity(show: false, isRunning: false, isWaitingShells: false, label: "")
    }

    /// The effective model: override > preferred > default fallback.
    var effectiveModel: String {
        let candidate = modelOverride ?? preferredModel
        return candidate.isEmpty ? "claude-sonnet-4-6" : candidate
    }

    private var displayLabel: String {
        availableModels.first(where: { $0.id == effectiveModel })?.label ?? effectiveModel
    }

    /// Rendering state for per-conversation thinking control. Model absent from
    /// registry resolves disabled, never hidden.
    var thinkingState: ThinkingControlState {
        let model = availableModels.first(where: { $0.id == effectiveModel })
        return ThinkingControlState.resolve(
            thinkingMode: model?.thinkingMode,
            thinkingEfforts: model?.thinkingEfforts
        )
    }

    /// Status bar renders exactly the rows the shared resolver offers. Keeping
    /// this as an alias prevents a second effort list from drifting when model
    /// capabilities add a level.
    private var thinkingOptions: [ThinkingControlState.Level] {
        thinkingState.levels
    }

    private var resolvedThinkingEffort: String {
        let allowed = availableModels.first(where: { $0.id == effectiveModel })?.thinkingEfforts ?? []
        guard !allowed.isEmpty else { return thinkingEffort }
        return thinkingOptions.contains(where: { $0.value == thinkingEffort })
            ? thinkingEffort
            : (thinkingOptions.first?.value ?? "off")
    }

    private var thinkingLabel: String {
        thinkingOptions.first(where: { $0.value == resolvedThinkingEffort })?.label ?? thinkingState.offLabel
    }


    /// Display label mirrors desktop `thinkingEffortLabel`. Kept as the
    /// public iOS parity seam used by codec tests; menu construction itself
    /// comes from ThinkingControlState to avoid a second capability list.
    static func effortLabel(_ effort: String) -> String {
        ThinkingControlState.label(for: effort)
    }

    private var thinkingLabelColor: Color {
        if !thinkingState.enabled { return Color(.tertiaryLabel) }
        return resolvedThinkingEffort == "off" ? Color.secondary : theme.accent
    }

    var body: some View {
        HStack(spacing: 10) {
            // Leading area: extension name (engine tabs only)
            if let name = extensionName, !name.isEmpty {
                Text(name)
                    .fontWeight(.medium)
                    .foregroundStyle(.primary)

                Divider()
                    .frame(height: 12)
            }

            // Running/waiting dot indicator.
            //
            // Three visual states, priority cascade matches the desktop's
            // StatusBarEngineState and the getTabStatusColor / TabRowView
            // .statusInfo / EngineInstanceBar.statusIndicator cascade:
            //   - isRunning (orchestrator running/connecting, derived from
            //     tab.status) → orange `theme.statusRunning` dot + "running",
            //     with the background-shell count appended when present
            //   - NOT running AND runningAgentCount > 0 → yellow
            //     `theme.statusWaitingChildren` dot + "waiting for N
            //     agent(s)"
            //   - NOT running, 0 agents, AND runningShellCount > 0 → pink
            //     `theme.statusBash` dot + "waiting for N background
            //     shell(s)"
            //   - otherwise → no dot/label (run-activity indicator only)
            //
            // Reads `isRunning` + `runningAgentCount` + `runningShellCount` —
            // the signals reliably present in the iOS view layer — NOT
            // `statusState`, which comes from `StatusFields.state` and is nil
            // whenever the orchestrator is idle with a child still running
            // (the bug this fixes). The pulse is implicit on iOS — the dot is
            // kept static here like the prior footer to avoid animating two
            // status surfaces at once; the label color carries the signal.
            // Decision pinned by ConversationStatusBarWaitingTests via
            // resolveRunActivity.
            let runActivity = Self.resolveRunActivity(
                isRunning: isRunning,
                runningAgentCount: runningAgentCount,
                runningShellCount: runningShellCount,
            )
            if runActivity.show {
                let activeColor = runActivity.isRunning
                    ? theme.statusRunning
                    : runActivity.isWaitingShells
                        ? theme.statusBash
                        : theme.statusWaitingChildren
                HStack(spacing: 4) {
                    Circle()
                        .fill(activeColor)
                        .frame(width: 6, height: 6)
                    Text(runActivity.label)
                        .foregroundStyle(activeColor)
                }

                Divider()
                    .frame(height: 12)
            }

            // Model picker trigger. Opens the provider-grouped sheet
            // (ModelPickerSheet) — at parity with the desktop popover, which a
            // flat Menu could not reach: no search, no collapsible provider
            // sections, no visible-but-disabled rows for unconfigured
            // providers. Disabled while the conversation is running, matching
            // the desktop's busy gate (a mid-run switch would not apply to the
            // turn in flight).
            Button {
                showModelPicker = true
            } label: {
                HStack(spacing: 2) {
                    Text(displayLabel)
                    Image(systemName: "chevron.down")
                        .font(.caption2)
                        .opacity(0.6)
                }
                .foregroundStyle(.secondary)
                .opacity(isRunning ? 0.5 : 1.0)
            }
            .buttonStyle(.plain)
            .disabled(isRunning)

            Spacer()

            // Permission mode toggle
            if let mode = permissionMode {
                if hasEngineExtension {
                    // Engine tabs: tapping shows a confirmation dialog before overriding
                    Button {
                        showModeConfirm = true
                    } label: {
                        HStack(spacing: 3) {
                            Image(systemName: mode == .plan ? "doc.text" : "bolt.fill")
                            Text(mode == .plan ? "Plan" : "Auto")
                                .fontWeight(.medium)
                        }
                        .foregroundStyle(mode == .plan ? theme.accent : .secondary)
                        .padding(.horizontal, 7) // design-geometry: 7pt nudge; off the 4pt ratio scale
                        .padding(.vertical, 3) // design-geometry: 3pt inset; below the 4pt rhythm floor
                        .background(Capsule().fill(Color(.tertiarySystemFill)))
                    }
                    .buttonStyle(.plain)
                } else {
                    Button(action: onToggleMode) {
                        HStack(spacing: 3) {
                            Image(systemName: mode == .plan ? "doc.text" : "bolt.fill")
                            Text(mode == .plan ? "Plan" : "Auto")
                                .fontWeight(.medium)
                        }
                        .foregroundStyle(mode == .plan ? theme.accent : .secondary)
                        .padding(.horizontal, 7) // design-geometry: 7pt nudge; off the 4pt ratio scale
                        .padding(.vertical, 3) // design-geometry: 3pt inset; below the 4pt rhythm floor
                        .background(Capsule().fill(Color(.tertiarySystemFill)))
                    }
                    .buttonStyle(.plain)
                }
            }

            // Per-conversation extended-thinking menu. Always renders; disabled
            // when active model has no selectable override level.
            Menu {
                ForEach(thinkingOptions, id: \.value) { level in
                    Button {
                        onSelectThinkingEffort(level.value)
                    } label: {
                        HStack {
                            Text(level.label)
                            if level.value == resolvedThinkingEffort {
                                Image(systemName: "checkmark")
                            }
                        }
                    }
                }
            } label: {
                HStack(spacing: 3) {
                    Image(systemName: "brain")
                    Text(thinkingLabel)
                        .fontWeight(.medium)
                }
                .foregroundStyle(thinkingLabelColor)
                .padding(.horizontal, 7) // design-geometry: 7pt nudge; off the 4pt ratio scale
                .padding(.vertical, 3) // design-geometry: 3pt inset; below the 4pt rhythm floor
                .background(Capsule().fill(Color(.tertiarySystemFill)))
            }
            .disabled(!thinkingState.enabled)

            // Attachments button
            Button(action: onTapAttachments) {
                HStack(spacing: 3) {
                    Image(systemName: "paperclip")
                    if attachmentCount > 0 {
                        Text("\(attachmentCount)")
                            .fontWeight(.medium)
                    }
                }
                .foregroundStyle(attachmentCount > 0 ? theme.accent : .secondary)
            }
            .buttonStyle(.plain)

            // Context usage stays mounted through every conversation lifecycle
            // state. When occupancy has not arrived, its neutral ring shows 0%.
            Button(action: onTapContextIndicator) {
                ContextUsageRing(percent: radialContextPercent, color: contextColor)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(contextAccessibilityLabel(pct: radialContextPercent))
        }
        .font(.caption2)
        .padding(.horizontal, IonSpace.contentGap)
        .padding(.vertical, IonSpace.compactInset)
        .background(.ultraThinMaterial)
        .confirmationDialog(
            "Change Mode",
            isPresented: $showModeConfirm,
            titleVisibility: .visible
        ) {
            let targetMode = permissionMode == .plan ? "Auto" : "Plan"
            Button("Switch to \(targetMode)") {
                onToggleMode()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The extension controls this tab's planning mode. Changing it manually may interfere with the extension's workflow.")
        }
        .sheet(isPresented: $showModelPicker) {
            ModelPickerSheet(
                models: availableModels,
                selectedModelId: effectiveModel,
                // The star marks the GLOBAL default, which is what
                // `preferredModel` carries; `effectiveModel` above folds in the
                // per-conversation override and is marked with the checkmark.
                preferredModelId: preferredModel,
                onSelect: handleSelectModel,
            )
        }
        .confirmationDialog(
            "Switch model?",
            isPresented: Binding(
                get: { pendingModelSwitch != nil },
                set: { if !$0 { pendingModelSwitch = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Switch anyway") {
                if let pending = pendingModelSwitch {
                    DiagnosticLog.log(
                        "model switch: operator accepted the re-write cost",
                        tag: "session",
                        level: .info,
                        fields: ["model": pending.model, "tokens": String(pending.estimate.tokens)]
                    )
                    onSelectModel(pending.model)
                }
                pendingModelSwitch = nil
            }
            Button("Stay on this model", role: .cancel) {
                DiagnosticLog.log(
                    "model switch: operator declined the re-write cost",
                    tag: "session",
                    level: .info,
                    fields: ["model": pendingModelSwitch?.model ?? ""]
                )
                pendingModelSwitch = nil
            }
        } message: {
            if let pending = pendingModelSwitch {
                Text(ModelSwitchCost.describe(pending.estimate)
                    + "\n\nA prompt cache belongs to one model, so the new model cannot read the cache this conversation already built.")
            }
        }
    }

    /// Confirm a model switch before applying it when the conversation already
    /// holds history.
    ///
    /// Switching the model a conversation runs on cannot reuse the prompt cache
    /// the previous model built — the cache is keyed per exact model — so the
    /// whole conversation is re-sent as cache-creation input on the next turn.
    /// `ModelSwitchCost.estimate` returns nil on a fresh or just-cleared
    /// conversation, which is exactly the case where the switch is free and the
    /// operator must not be interrupted.
    private func handleSelectModel(_ model: String) {
        let estimate = ModelSwitchCost.estimate(
            contextTokens: contextTokens,
            targetModel: availableModels.first(where: { $0.id == model }),
            currentModel: availableModels.first(where: { $0.id == effectiveModel })
        )
        guard let estimate, model != effectiveModel else {
            onSelectModel(model)
            return
        }
        DiagnosticLog.log(
            "model switch: confirming mid-conversation switch",
            tag: "session",
            level: .info,
            fields: ["from": effectiveModel, "to": model, "tokens": String(estimate.tokens)]
        )
        pendingModelSwitch = (model: model, estimate: estimate)
    }
}

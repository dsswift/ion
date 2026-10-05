import SwiftUI

/// The conversation's inline controls, rendered inside the composer's controls
/// row: the model picker, the permission mode, the thinking effort, and the
/// context ring. The composer places its own attach and send controls around
/// this row; the running/waiting indicator lives in `ConversationActivityStrip`
/// above the composer, and the attachments panel opens from the toolbar.
///
/// This is the iOS counterpart of the desktop's `ComposerControls`: the same
/// controls in the same place, under the composer text. The static resolvers
/// below (`resolveEngineInputs`, `resolveRunActivity`, and the context
/// arithmetic in `ConversationStatusBar+Context.swift`) are shared with the
/// activity strip and pinned by their own tests.
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
    /// Unix ms of the conversation's last real turn — the turn that wrote the
    /// prompt cache. The model-switch estimate needs it because the cheap
    /// stay-put rate only applies while that cache is still readable; past the
    /// model's published lifetime the next turn re-writes the whole prompt
    /// regardless of which model runs it. Nil means unknown, and the estimate
    /// says so rather than assuming the cache survived.
    var lastTurnAtMs: Double? = nil
    let isRunning: Bool
    let permissionMode: PermissionMode?
    let availableModels: [RemoteModelEntry]
    let onSelectModel: (String, String) -> Void
    let onToggleMode: () -> Void
    var onTapContextIndicator: () -> Void = {}

    /// Engine tabs confirm a manual mode change, because the extension that
    /// drives the conversation may be steering the mode itself.
    var hasEngineExtension: Bool = false

    /// The engine's last refusal of a plan-mode change. While present, a line
    /// under the controls says why the mode control did not switch.
    var planModeRejection: PlanModeRejection? = nil

    // Extended-thinking (per-conversation). The Think control always renders
    // beside the mode control. It disables when the active model has no
    // selectable effort levels, preserving layout and explaining unavailable
    // capability. The neutral entry is Adaptive for self-regulating models,
    // Off otherwise. Level is isolated per conversation and applied on the
    // next prompt.
    var thinkingEffort: String = "off"
    var onSelectThinkingEffort: (String) -> Void = { _ in }

    @State private var showModeConfirm = false
    @State private var showModelPicker = false
    /// A model switch the operator chose but has not paid for yet. Held until
    /// they accept the prompt-cache re-write cost; nil when nothing is pending.
    @State private var pendingModelSwitch: (model: String, providerId: String, estimate: ModelSwitchCost.Estimate)?

    /// Engine-derived inputs for the controls and the activity strip, resolved
    /// nil-safely from an optional `StatusFields`. The controls must ALWAYS
    /// render; when an engine instance has no status yet, these fall back to
    /// safe values so the model picker and mode control stay usable, and the
    /// context ring stays mounted at a neutral 0% until occupancy arrives.
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

    /// Run-activity decision for the activity strip above the composer.
    ///
    /// Derived from the signals reliably present in the iOS view layer —
    /// `isRunning` (orchestrator run-state, which `ConversationView` derives
    /// from `tab.status`), `runningAgentCount` (dispatched agents), and
    /// `runningShellCount` (outstanding background bash commands). It does
    /// NOT read `StatusFields.state`: that field is non-Codable and
    /// snapshot-excluded on iOS, so gating on it hid the "waiting for N
    /// agent(s)" label whenever the orchestrator went idle with a child still
    /// running.
    ///
    /// Priority cascade keeps the foreground colour when the orchestrator runs,
    /// but its label also includes any concurrent background-shell count. An
    /// idle orchestrator shows agents before shells. When no work applies,
    /// `show` is false and the strip renders nothing.
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

    /// The effective model: the conversation's own pick, else the default its
    /// server resolved. Empty when the server resolved nothing; the phone never
    /// substitutes a model id of its own.
    var effectiveModel: String {
        modelOverride ?? preferredModel
    }

    private var displayLabel: String {
        ModelCatalog.displayLabel(for: effectiveModel, in: availableModels)
    }

    /// Rendering state for per-conversation thinking control. Model absent from
    /// registry resolves disabled, never hidden.
    var thinkingState: ThinkingControlState {
        let model = ModelCatalog.entry(for: effectiveModel, in: availableModels)
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
        let allowed = ModelCatalog.entry(for: effectiveModel, in: availableModels)?.thinkingEfforts ?? []
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

    /// Whether the Think control carries a non-neutral level, which is when
    /// it shows its level beside the glyph and takes the accent.
    private var thinkingIsRaised: Bool {
        thinkingState.enabled && resolvedThinkingEffort != thinkingOptions.first?.value
    }

    /// The line shown under the controls for a refused plan-mode change, or
    /// nil when nothing was refused.
    static func planModeRefusalText(_ rejection: PlanModeRejection?) -> String? {
        guard let rejection else { return nil }
        let reason = rejection.reason.trimmingCharacters(in: .whitespacesAndNewlines)
        let mode = rejection.requestedEnabled ? "Plan" : "Auto"
        return reason.isEmpty ? "\(mode) mode was refused." : "\(mode) mode was refused: \(reason)"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: IonSpace.hairlineGap) {
            controlsRow
            if let refusal = Self.planModeRefusalText(planModeRejection) {
                Text(refusal)
                    .font(IonType.microLabel)
                    .foregroundStyle(theme.statusWarning)
                    .lineLimit(2)
                    .accessibilityLabel(refusal)
            }
        }
        .font(IonType.metadata)
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
                // The catalog's own id for the running model, so the picker's
                // checkmark lands on its row even when the conversation
                // carries the provider-qualified form.
                selectedModelId: ModelCatalog.entry(for: effectiveModel, in: availableModels)?.id ?? effectiveModel,
                // The star marks the default this conversation falls back to,
                // which is what `preferredModel` carries; `effectiveModel` above
                // folds in the per-conversation pick and gets the checkmark.
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
                    onSelectModel(pending.model, pending.providerId)
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
                Text([ModelSwitchCost.describe(pending.estimate), ModelSwitchCost.reason(pending.estimate)]
                    .compactMap { $0 }
                    .joined(separator: "\n\n"))
            }
        }
    }

    // MARK: - Controls

    /// Model picker trigger. Opens the provider-grouped sheet
    /// (ModelPickerSheet) — at parity with the desktop popover, which a
    /// flat Menu could not reach: no search, no collapsible provider
    /// sections, no visible-but-disabled rows for unconfigured providers.
    /// Disabled while the conversation is running, matching the desktop's
    /// busy gate (a mid-run switch would not apply to the turn in flight).
    private var modelControl: some View {
        Button {
            showModelPicker = true
        } label: {
            HStack(spacing: IonSpace.hairlineGap) {
                Text(displayLabel)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Image(systemName: "chevron.down")
                    .font(IonType.microLabel)
            }
            .foregroundStyle(theme.textSecondary)
            .opacity(isRunning ? 0.5 : 1.0)
        }
        .buttonStyle(.plain)
        .disabled(isRunning)
        // The model name is the one label here that can be long; it yields
        // width to the fixed controls before they are forced to wrap.
        .layoutPriority(-1)
        .accessibilityLabel("Model, \(displayLabel)")
    }

    /// The model, mode, and thinking controls with the context ring.
    private var controlsRow: some View {
        HStack(spacing: IonSpace.compactGap) {
            modelControl
            if permissionMode != nil {
                modeControl
            }
            thinkingControl
            Spacer(minLength: 0)
            // Context usage stays mounted through every conversation lifecycle
            // state. When occupancy has not arrived, its neutral ring shows 0%.
            Button(action: onTapContextIndicator) {
                ContextUsageRing(percent: radialContextPercent, color: contextColor)
                    .frame(minWidth: IonSpace.screenInset, minHeight: IonSpace.screenInset)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(contextAccessibilityLabel(pct: radialContextPercent))
        }
    }

    /// Permission mode. A plain conversation toggles on tap; an engine
    /// conversation confirms first, because the extension may own the mode.
    private var modeControl: some View {
        let isPlan = permissionMode == .plan
        return Button {
            if hasEngineExtension {
                showModeConfirm = true
            } else {
                onToggleMode()
            }
        } label: {
            HStack(spacing: IonSpace.hairlineGap) {
                Image(systemName: isPlan ? "doc.text" : "bolt.fill")
                Text(isPlan ? "Plan" : "Auto")
            }
            .foregroundStyle(isPlan ? theme.accent : theme.textSecondary)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isPlan ? "Plan mode" : "Auto mode")
    }

    /// Per-conversation extended-thinking menu. Always renders; disabled
    /// when the active model has no selectable override level. Shows its
    /// level only when raised above the model's neutral setting, so the
    /// common case costs the row one glyph.
    private var thinkingControl: some View {
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
            HStack(spacing: IonSpace.hairlineGap) {
                Image(systemName: "brain")
                if thinkingIsRaised {
                    Text(thinkingLabel)
                }
            }
            .foregroundStyle(thinkingState.enabled
                ? (thinkingIsRaised ? theme.accent : theme.textSecondary)
                : theme.textTertiary)
        }
        .disabled(!thinkingState.enabled)
        .accessibilityLabel("Thinking, \(thinkingLabel)")
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
    private func handleSelectModel(_ model: String, _ providerId: String) {
        let estimate = ModelSwitchCost.estimate(
            contextTokens: contextTokens,
            targetModel: ModelCatalog.entry(for: model, in: availableModels),
            currentModel: ModelCatalog.entry(for: effectiveModel, in: availableModels),
            lastActivityAt: lastTurnAtMs.map { Date(timeIntervalSince1970: $0 / 1000) }
        )
        guard let estimate, model != (ModelCatalog.entry(for: effectiveModel, in: availableModels)?.id ?? effectiveModel) else {
            onSelectModel(model, providerId)
            return
        }
        DiagnosticLog.log(
            "model switch: confirming mid-conversation switch",
            tag: "session",
            level: .info,
            fields: [
                "from": effectiveModel,
                "to": model,
                "tokens": String(estimate.tokens),
                "cache_state": estimate.cacheState.rawValue,
                "idle_seconds": estimate.idleSeconds.map { String(Int($0)) } ?? "unknown",
                "cache_ttl_seconds": estimate.cacheTtlSeconds.map(String.init) ?? "unknown",
            ]
        )
        pendingModelSwitch = (model: model, providerId: providerId, estimate: estimate)
    }
}

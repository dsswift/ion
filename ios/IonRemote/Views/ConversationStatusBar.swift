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

    // Extended-thinking (per-conversation). Think menu always renders beside
    // permission toggle. It disables when active model has no selectable effort
    // levels, preserving layout and explaining unavailable capability. The
    // neutral entry is Adaptive for self-regulating models, Off otherwise.
    // Level is isolated per conversation/subtab and applied on next prompt.
    var thinkingEffort: String = "off"
    var onSelectThinkingEffort: (String) -> Void = { _ in }

    @State private var showModeConfirm = false
    @State private var showModelPicker = false

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
    /// Derived from the two signals that are reliably present in the iOS view
    /// layer — `isRunning` (orchestrator run-state, which `ConversationView`
    /// derives from `tab.status`) and `runningAgentCount` (the live count of
    /// dispatched agents in the `running` status). It does NOT read
    /// `StatusFields.state`: that field is non-Codable and snapshot-excluded on
    /// iOS, so gating the dot on it hid the yellow "waiting for N agent(s)"
    /// label whenever the orchestrator went idle with a child still running.
    ///
    /// Priority cascade (matches the desktop `getTabStatusColor` /
    /// `TabRowView.statusInfo`): foreground orange "running" beats background
    /// yellow "awaiting children". When neither applies, `show` is false and the
    /// bar renders no dot/label (this is a run-activity indicator only — there is
    /// no idle label). Pure + static so it is unit-testable directly, pinning the
    /// shipped logic rather than a re-derivation.
    struct RunActivity: Equatable {
        let show: Bool
        let isRunning: Bool
        let label: String
    }

    static func resolveRunActivity(isRunning: Bool, runningAgentCount: Int) -> RunActivity {
        if isRunning {
            return RunActivity(show: true, isRunning: true, label: "running")
        }
        if runningAgentCount > 0 {
            let suffix = runningAgentCount == 1 ? "" : "s"
            return RunActivity(
                show: true,
                isRunning: false,
                label: "waiting for \(runningAgentCount) agent\(suffix)",
            )
        }
        return RunActivity(show: false, isRunning: false, label: "")
    }

    /// The effective model: override > preferred > default fallback.
    private var effectiveModel: String {
        let candidate = modelOverride ?? preferredModel
        return candidate.isEmpty ? "claude-sonnet-4-6" : candidate
    }

    private var displayLabel: String {
        availableModels.first(where: { $0.id == effectiveModel })?.label ?? effectiveModel
    }

    /// Resolved context occupancy percentage. UNBOUNDED — may exceed 100.
    ///
    /// Tokens-first, matching the desktop: divide the engine's absolute
    /// occupancy figure by the SELECTED model's window. No engine command can
    /// change an idle session's model, so a picker-driven recompute has to be
    /// client-side arithmetic — this is what makes switching a 220k-token
    /// conversation from a 1M model to a 100k one read 220% immediately.
    ///
    /// `contextPercent` is the fallback for a session whose engine has not
    /// reported a token count (an older engine, or a backend that emits no
    /// usage). That percentage is anchored to whatever window the engine
    /// measured against, so it cannot react to the picker.
    ///
    /// Not capped: over-budget is real information, and an operator at 220%
    /// needs to see 220% rather than a figure identical to exactly-full.
    /// Callers clamp for geometry only.
    var resolvedContextPercent: Double? {
        Self.resolveContextPercent(
            contextPercent: contextPercent,
            contextTokens: contextTokens,
            selectedModelWindow: selectedModelWindow,
        )
    }

    /// Pure form of the above, so every iOS surface that shows context usage
    /// (this bar, the conversation header's fill strip) resolves one number
    /// from one implementation and the two can never disagree.
    static func resolveContextPercent(
        contextPercent: Double?,
        contextTokens: Int?,
        selectedModelWindow: Int?,
    ) -> Double? {
        if let tokens = contextTokens, tokens > 0, let denominator = selectedModelWindow, denominator > 0 {
            return Double(tokens) / Double(denominator) * 100.0
        }
        if let cp = contextPercent {
            return cp
        }
        return nil
    }

    /// The absolute occupancy figure to divide by the window — the NUMERATOR
    /// counterpart to `windowForModel`'s denominator. Static for the same reason
    /// as the two resolvers around it: every iOS surface that shows context usage
    /// resolves one number from one implementation, so they cannot disagree.
    ///
    /// A context breakdown carries three token quantities that are easy to
    /// confuse, and only one of them is occupancy:
    ///
    ///   - `breakdownOccupancy` (`occupancyTokens`) — the engine's authoritative
    ///     occupancy. The same figure `StatusFields.contextTokens` carries and the
    ///     same input the engine's proactive-compaction gate measures. THIS is
    ///     what divides by the context window.
    ///   - `breakdownTotal` (`totalTokens`) — the ITEMIZED per-category sum. An
    ///     independent estimate meant for attribution ("what is taking up the
    ///     space"). It OVER-reports, counting content the provider did not bill
    ///     for this turn, so it must never be read as occupancy: doing so
    ///     rendered a conversation occupying 26% of a 1M window as ~103%.
    ///   - `apiReportedTotal` (not accepted here) — the raw provider
    ///     input_tokens for the last turn, with nothing added for messages
    ///     appended since, so it UNDER-reports mid-turn.
    ///
    /// `breakdownTotal` is a parameter purely so this contract is stated at the
    /// one place the decision is made. It is deliberately never returned — a
    /// caller that has it in hand passes it here and gets back the right number.
    static func resolveContextTokens(
        breakdownOccupancy: Int?,
        breakdownTotal: Int?,
        fieldsTokens: Int?,
        instanceTokens: Int?,
    ) -> Int? {
        if let t = breakdownOccupancy, t > 0 { return t }
        if let t = fieldsTokens, t > 0 { return t }
        if let t = instanceTokens, t > 0 { return t }
        return nil
    }

    /// Client-side capacity state. The effective limit reserves response and
    /// compaction room from the selected model's raw context window.
    enum ContextCapacityState: Equatable {
        case normal
        case warning
        case full
    }

    struct ContextCapacity: Equatable {
        let occupancyTokens: Int
        let effectiveLimit: Int
        let percent: Double
    }

    /// Default output reserve when model metadata declares no output cap.
    /// Mirrors DEFAULT_CONTEXT_OUTPUT_RESERVE in shared/context-capacity.ts.
    static let defaultContextOutputReserve = 20_000

    /// Compaction-summary reserve. Mirrors CONTEXT_SUMMARY_RESERVE there.
    static let contextSummaryReserve = 13_000

    /// Mirror the engine's input-budget calculation. The engine-reported
    /// effective limit wins when it is present, because it IS the engine's own
    /// arithmetic for the model the engine used. The client only recomputes from
    /// the selected model's window and output reserve, which is what makes the
    /// picker update admission before another request reaches the engine.
    static func resolveContextCapacity(
        occupancyTokens: Int?,
        modelId: String,
        availableModels: [RemoteModelEntry],
        engineContextWindow: Int?,
        engineEffectiveLimit: Int? = nil,
    ) -> ContextCapacity? {
        guard let occupancyTokens, occupancyTokens > 0 else { return nil }
        let selected = availableModels.first(where: { $0.id == modelId })
        // The engine's answer is only authoritative while the operator has not
        // moved the picker to a model the engine has not run. A selected model
        // that declares its own limit or window takes precedence.
        if let reported = engineEffectiveLimit, reported > 0,
           selected?.effectiveContextLimit == nil, selected?.contextWindow == nil {
            return ContextCapacity(
                occupancyTokens: occupancyTokens,
                effectiveLimit: reported,
                percent: Double(occupancyTokens) / Double(reported) * 100,
            )
        }
        // The selected model's own published limit is the engine's arithmetic
        // for THAT model, so it beats recomputing the reserves locally.
        if let declared = selected?.effectiveContextLimit, declared > 0 {
            return ContextCapacity(
                occupancyTokens: occupancyTokens,
                effectiveLimit: declared,
                percent: Double(occupancyTokens) / Double(declared) * 100,
            )
        }
        guard let rawWindow = windowForModel(
            modelId,
            availableModels: availableModels,
            engineContextWindow: engineContextWindow,
        ), rawWindow > 0 else {
            guard let reported = engineEffectiveLimit, reported > 0 else { return nil }
            return ContextCapacity(
                occupancyTokens: occupancyTokens,
                effectiveLimit: reported,
                percent: Double(occupancyTokens) / Double(reported) * 100,
            )
        }

        let declaredOutput = selected?.maxOutputTokens ?? 0
        let outputReserve = declaredOutput > 0 ? declaredOutput : defaultContextOutputReserve
        let effectiveLimit = rawWindow - outputReserve - contextSummaryReserve
        let limit = effectiveLimit > 0 ? effectiveLimit : rawWindow
        return ContextCapacity(
            occupancyTokens: occupancyTokens,
            effectiveLimit: limit,
            percent: Double(occupancyTokens) / Double(limit) * 100,
        )
    }

    static func contextCapacityState(_ capacity: ContextCapacity?) -> ContextCapacityState {
        guard let capacity else { return .normal }
        if capacity.percent >= 100 { return .full }
        if capacity.percent >= 80 { return .warning }
        return .normal
    }

    /// `/compact` and `/clear` are recovery commands. They remain available
    /// when a normal prompt would exceed the selected model's input budget.
    static func isContextRecoveryCommand(_ text: String) -> Bool {
        let command = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return command == "/compact" || command.hasPrefix("/compact ") ||
            command == "/clear" || command.hasPrefix("/clear ")
    }

    static func contextCapacityBlocksPrompt(_ capacity: ContextCapacity?, text: String) -> Bool {
        contextCapacityState(capacity) == .full && !isContextRecoveryCommand(text)
    }

    /// Context window of a named model from the catalog, falling back to the
    /// engine's reported window. Static so non-bar surfaces can resolve the
    /// same denominator.
    static func windowForModel(
        _ modelId: String,
        availableModels: [RemoteModelEntry],
        engineContextWindow: Int?,
    ) -> Int? {
        if let model = availableModels.first(where: { $0.id == modelId }), model.contextWindow > 0 {
            return model.contextWindow
        }
        if let engineWindow = engineContextWindow, engineWindow > 0 {
            return engineWindow
        }
        return nil
    }

    /// Context window of the model currently SELECTED in the picker — the
    /// display denominator. Falls back to the engine's window when the picker
    /// model is not in the catalog (so the reading degrades to the engine's
    /// own view rather than vanishing).
    private var selectedModelWindow: Int? {
        Self.windowForModel(effectiveModel, availableModels: availableModels, engineContextWindow: engineContextWindow)
    }

    /// Presentation percentage for the persistent context ring. Missing
    /// occupancy renders as a neutral 0% ring so a fresh, idle, completed, or
    /// background-agent-waiting conversation never loses its tap target.
    var radialContextPercent: Double {
        resolvedContextPercent ?? 0
    }

    /// Accessible name for the context ring. Carries the true uncapped
    /// percentage plus the raw counts, since no number is rendered as text.
    func contextAccessibilityLabel(pct: Double) -> String {
        if let tokens = contextTokens, tokens > 0, let window = selectedModelWindow, window > 0 {
            return "Context usage \(Int(pct)) percent, \(tokens) of \(window) tokens"
        }
        return "Context usage \(Int(pct)) percent"
    }

    private var contextColor: Color {
        guard let pct = resolvedContextPercent else { return .secondary }
        // ContextUsageRing owns the one threshold ladder — see its `level(_:)`.
        return ContextUsageRing.color(for: pct)
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
            // Two visual states, priority cascade matches the desktop's
            // StatusBarEngineState and the getTabStatusColor / TabRowView
            // .statusInfo cascade:
            //   - isRunning (orchestrator running/connecting, derived from
            //     tab.status) → orange `theme.statusRunning` dot + "running"
            //   - NOT running AND runningAgentCount > 0 → yellow
            //     `theme.statusWaitingChildren` dot + "waiting for N
            //     agent(s)"
            //   - otherwise → no dot/label (run-activity indicator only)
            //
            // Reads `isRunning` + `runningAgentCount` — the signals reliably
            // present in the iOS view layer — NOT `statusState`, which comes
            // from `StatusFields.state` and is nil whenever the orchestrator is
            // idle with a child still running (the bug this fixes). The pulse
            // is implicit on iOS — the dot is kept static here like the prior
            // footer to avoid animating two status surfaces at once; the label
            // color carries the signal. Decision pinned by
            // ConversationStatusBarWaitingTests via resolveRunActivity.
            let runActivity = Self.resolveRunActivity(
                isRunning: isRunning,
                runningAgentCount: runningAgentCount,
            )
            if runActivity.show {
                let activeColor = runActivity.isRunning
                    ? theme.statusRunning
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
                onSelect: onSelectModel,
            )
        }
    }
}

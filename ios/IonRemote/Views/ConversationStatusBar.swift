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

    // Extended-thinking (per-conversation). When `thinkingGloballyEnabled` is
    // true AND the active model declares thinking efforts, a Think menu
    // (Off/Low/Medium/High) renders next to the permission toggle. The level
    // is isolated per conversation/subtab and applied live on the next prompt.
    // Declared after the engine params so both call sites (engine + bare) can
    // pass these as trailing arguments in declaration order.
    var thinkingGloballyEnabled: Bool = false
    var thinkingEffort: String = "off"
    var onSelectThinkingEffort: (String) -> Void = { _ in }

    @State private var showModeConfirm = false

    /// Engine-derived inputs for the status bar, resolved nil-safely from an
    /// optional `StatusFields`. The bar must ALWAYS render for engine tabs (like
    /// it does for plain conversations); when an engine instance has no status
    /// yet, these fall back to safe values so the core controls (model picker,
    /// permission toggle, attachments) stay visible and the status-dependent
    /// chrome (status dot, context %, extension name) self-hides.
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

    /// Effort levels the active model accepts (empty ⇒ unsupported).
    private var thinkingEfforts: [String] {
        availableModels.first(where: { $0.id == effectiveModel })?.thinkingEfforts ?? []
    }

    /// Whether the per-conversation thinking control should render: the global
    /// setting is on AND the active model supports reasoning.
    private var showThinkingControl: Bool {
        thinkingGloballyEnabled && !thinkingEfforts.isEmpty
    }

    private var thinkingLabel: String {
        switch thinkingEffort {
        case "low": return "Low"
        case "medium": return "Medium"
        case "high": return "High"
        default: return "Off"
        }
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

            // Model picker menu
            Menu {
                ForEach(availableModels) { model in
                    Button {
                        onSelectModel(model.id)
                    } label: {
                        HStack {
                            Text(model.label)
                            if model.modelKind == "image" {
                                Text("image gen")
                            }
                            if model.id == effectiveModel {
                                Image(systemName: "checkmark")
                            }
                        }
                    }
                }
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
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
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
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(Capsule().fill(Color(.tertiarySystemFill)))
                    }
                    .buttonStyle(.plain)
                }
            }

            // Per-conversation extended-thinking menu. Self-hides when the
            // global setting is off or the active model has no efforts.
            if showThinkingControl {
                Menu {
                    ForEach(["off", "low", "medium", "high"], id: \.self) { level in
                        // Off is always offered; other levels only when the
                        // model declares them (e.g. grok-mini omits medium).
                        if level == "off" || thinkingEfforts.contains(level) {
                            Button {
                                onSelectThinkingEffort(level)
                            } label: {
                                HStack {
                                    Text(level == "off" ? "Off" : level.capitalized)
                                    if level == thinkingEffort {
                                        Image(systemName: "checkmark")
                                    }
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
                    .foregroundStyle(thinkingEffort == "off" ? Color.secondary : theme.accent)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(Capsule().fill(Color(.tertiarySystemFill)))
                }
            }

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

            // Context usage (only when data is available). The ring replaced
            // the percentage text, so the accessibility label is what carries
            // the figure — including the true uncapped value when the arc
            // itself has saturated.
            if let pct = resolvedContextPercent {
                Button(action: onTapContextIndicator) {
                    ContextUsageRing(percent: pct, color: contextColor)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(contextAccessibilityLabel(pct: pct))
            }
        }
        .font(.caption2)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
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
    }
}

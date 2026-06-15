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

    // Engine-specific optional parameters
    var hasEngineExtension: Bool = false
    var extensionName: String? = nil
    var statusState: String? = nil
    /// Number of dispatched background agents currently running.
    /// When `statusState == "idle"` and this is > 0 the bar renders
    /// the yellow "awaiting children" pulse + label instead of the
    /// gray "idle" text. Mirrors the desktop's `agentRunningCount`
    /// prop on `EngineFooter`. Defaults to 0 for older snapshots
    /// that don't carry the field.
    var runningAgentCount: Int = 0

    @State private var showModeConfirm = false

    /// The effective model: override > preferred > default fallback.
    private var effectiveModel: String {
        let candidate = modelOverride ?? preferredModel
        return candidate.isEmpty ? "claude-sonnet-4-6" : candidate
    }

    private var displayLabel: String {
        availableModels.first(where: { $0.id == effectiveModel })?.label ?? effectiveModel
    }

    /// Resolved context percentage (0–100) from either direct percent or computed from tokens.
    private var resolvedContextPercent: Double? {
        if let cp = contextPercent {
            return cp
        }
        if let tokens = contextTokens {
            // Prefer the engine-reported window over the picker-selected
            // model's nominal window. They diverge whenever the user
            // changes the picker between turns; honoring the engine's
            // truth keeps the indicator accurate. Falls back to the
            // picker model's window only when the engine has not yet
            // reported (cold-start tabs). See plan cosy-pacing-bee.md for
            // the regression this fix prevents.
            let denominator: Int
            if let engineWindow = engineContextWindow, engineWindow > 0 {
                denominator = engineWindow
            } else if let model = availableModels.first(where: { $0.id == effectiveModel }), model.contextWindow > 0 {
                denominator = model.contextWindow
            } else {
                return nil
            }
            return Double(tokens) / Double(denominator) * 100.0
        }
        return nil
    }

    private var contextColor: Color {
        guard let pct = resolvedContextPercent else { return .secondary }
        if pct >= 80 { return .red }
        if pct >= 60 { return .orange }
        return .secondary
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

            // Running/idle/waiting dot indicator (when statusState is provided).
            //
            // Three visual states, priority cascade matches desktop's
            // EngineFooter and the StatusDot/getTabStatusColor cascade
            // in TabStripStatusDot.tsx / TabStripShared.ts:
            //   - state == "running"  → orange `theme.statusRunning`
            //     dot, label = state text (orange/foreground)
            //   - state == "idle" AND runningAgentCount > 0 →
            //     yellow `theme.statusWaitingChildren` dot, label =
            //     "waiting for N background agent(s)" (yellow/background)
            //   - otherwise → gray dot, plain `state` text (truly idle)
            //
            // The pulse is implicit on iOS — the InstancePulsingDot
            // is reused in EngineInstanceBar; for this footer we keep
            // the dot static like the prior implementation to avoid
            // animating two separate status bars on screen. The label
            // color carries the signal.
            if let state = statusState {
                let isRunningState = state.lowercased() == "running"
                let isWaitingChildren = state.lowercased() == "idle" && runningAgentCount > 0
                let dotColor: Color = isRunningState
                    ? theme.statusRunning
                    : (isWaitingChildren ? theme.statusWaitingChildren : Color.gray)
                let labelColor: Color = isRunningState
                    ? theme.statusRunning
                    : (isWaitingChildren ? theme.statusWaitingChildren : Color.secondary)
                let labelText: String = isWaitingChildren
                    ? "waiting for \(runningAgentCount) background agent\(runningAgentCount == 1 ? "" : "s")"
                    : state
                HStack(spacing: 4) {
                    Circle()
                        .fill(dotColor)
                        .frame(width: 6, height: 6)
                    Text(labelText)
                        .foregroundStyle(labelColor)
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

            // Context usage (only when data is available)
            if let pct = resolvedContextPercent {
                HStack(spacing: 4) {
                    ProgressView(value: min(pct / 100.0, 1.0))
                        .frame(width: 40)
                        .tint(contextColor)
                    Text("\(Int(pct))%")
                        .foregroundStyle(contextColor)
                }
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

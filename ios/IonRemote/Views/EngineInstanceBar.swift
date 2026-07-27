import SwiftUI

/// Horizontal scrollable bar showing engine instance tabs within an engine tab.
/// Modeled on `TerminalInstanceBar` with simplified behavior.
///
/// With the single-instance collapse (#256), this bar is only shown when a
/// legacy snapshot carries multiple instances (the `if instances.count > 1`
/// guard in ConversationView). Instance management actions (add, remove, move,
/// rename) have been removed. The bar now shows read-only status and
/// clipboard copy for session IDs.
struct EngineInstanceBar: View {
    let tabId: String
    let instances: [ConversationInstanceInfo]
    let activeInstanceId: String
    @Environment(SessionViewModel.self) private var viewModel
    /// When non-nil, surfaces a small alert describing the model-fallback
    /// for the corresponding instance — tapped by the user on the ⚠
    /// glyph rendered in `instanceButton`. iOS has no tooltip primitive
    /// equivalent to the desktop's Tooltip component, so an alert is the
    /// idiomatic disclosure surface for this kind of one-shot detail.
    @State private var fallbackDetail: (instanceLabel: String, info: EngineInstanceModelFallback)? = nil

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 2) {
                ForEach(instances) { instance in
                    instanceButton(instance)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
        }
        .background(.ultraThinMaterial)
        // Model-fallback disclosure alert. Triggered when the user taps
        // the ⚠ glyph rendered next to an instance label in
        // `instanceButton`. Shows the requested vs. fallback model
        // names so the user understands which model is actually running.
        .alert("Model fallback", isPresented: Binding(
            get: { fallbackDetail != nil },
            set: { if !$0 { fallbackDetail = nil } }
        )) {
            Button("OK", role: .cancel) { fallbackDetail = nil }
        } message: {
            if let detail = fallbackDetail {
                Text("Instance \"\(detail.instanceLabel)\" requested model \"\(detail.info.requestedModel)\" which isn't configured; running with default \"\(detail.info.fallbackModel)\" instead.")
            }
        }
    }

    /// Merges live `statusFields.sessionId` with historical `conversationIds`
    /// for the given engine instance. Returns all IDs (historical first,
    /// live appended if not already present). Matches the desktop
    /// SettingsPopover merge logic.
    private func mergedSessionIds(for instance: ConversationInstanceInfo) -> [String] {
        var ids = instance.conversationIds ?? []
        if let current = instance.statusFields?.sessionId, !ids.contains(current) {
            ids.append(current)
        }
        return ids
    }

    @ViewBuilder
    private func instanceButton(_ instance: ConversationInstanceInfo) -> some View {
        // Read-only pill: shows status dot, bolt icon, label, model-fallback indicator.
        // Tap is a no-op (single-instance — no switching needed). Context menu
        // still offers session-ID clipboard copy for debugging.
        HStack(spacing: 4) {
            // Per-instance status dot. Priority:
            // 1. waitingState (question → blue, plan-ready → green)
            // 2. isRunning → pulsing orange
            // 3. runningAgentCount > 0 → pulsing yellow
            // 4. backgroundShellCount > 0 → pulsing pink (background bash
            //    commands the session is holding for; ranked under agents,
            //    matching the tab-dot cascade in TabStatusRollup)
            // 5. None → no dot shown
            if let ws = instance.waitingState {
                Circle()
                    .fill(ws == "question" ? Color(hex: 0x4A9EF5) : Color.green)
                    .frame(width: 6, height: 6)
            } else if instance.isRunning == true {
                InstancePulsingDot()
            } else if (instance.runningAgentCount ?? 0) > 0 {
                InstanceWaitingChildrenDot()
            } else if (instance.backgroundShellCount ?? 0) > 0 {
                InstanceWaitingShellsDot()
            }
            Image(systemName: "bolt")
                .font(.caption2)
            Text(instance.label)
                .font(.caption)
                .lineLimit(1)

            // Background-shell count. Shown only when the instance is not
            // otherwise busy, so the bar reports the ONE thing the session is
            // actually waiting on rather than stacking indicators.
            if instance.isRunning != true,
               (instance.runningAgentCount ?? 0) == 0,
               let shells = instance.backgroundShellCount, shells > 0 {
                Text("\(shells) shell\(shells == 1 ? "" : "s")")
                    .font(.caption2)
                    .foregroundStyle(TabStatusRollup.shellPink)
                    .accessibilityLabel("Waiting on \(shells) background shell\(shells == 1 ? "" : "s")")
            }

            // Model-fallback indicator.
            if let fb = instance.modelFallback {
                Button {
                    fallbackDetail = (instanceLabel: instance.label, info: fb)
                } label: {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 10))
                        .foregroundStyle(Color(hex: 0x4A9EF5))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Model fallback active for \(instance.label)")
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(instance.id == activeInstanceId ? Color.orange.opacity(0.2) : Color.clear)
        )
        .foregroundStyle(instance.id == activeInstanceId ? .primary : .secondary)
        .contextMenu {
            // Session-ID clipboard copy retained for debugging.
            let allIds = mergedSessionIds(for: instance)
            if !allIds.isEmpty {
                Button {
                    UIPasteboard.general.string = allIds.joined(separator: "\n")
                    viewModel.showToast(ToastMessage(style: .success, title: "Session ID copied"))
                } label: {
                    Label("Copy Session ID", systemImage: "doc.on.doc")
                }
            }
        }
    }
}

// MARK: - InstancePulsingDot

/// Small pulsing orange dot for running engine instances. Matches the
/// pulse animation from `TabRowView` (1.5s easeInOut, opacity 1→0.3).
private struct InstancePulsingDot: View {
    @Environment(\.appTheme) private var theme
    @State private var pulseOpacity: Double = 1.0

    var body: some View {
        Circle()
            .fill(theme.statusRunning)
            .frame(width: 6, height: 6)
            .opacity(pulseOpacity)
            .onAppear {
                withAnimation(.easeInOut(duration: 1.5).repeatForever(autoreverses: true)) {
                    pulseOpacity = 0.3
                }
            }
    }
}

// MARK: - InstanceWaitingChildrenDot

/// Small pulsing yellow/amber dot for engine instances whose
/// orchestrator is idle but whose dispatched background agents are
/// still executing. Same pulse animation as `InstancePulsingDot`,
/// only the fill color differs (theme.statusWaitingChildren ⇒
/// "awaiting background work"). Matches the desktop's
/// statusWaitingChildren palette and the yellow branch in
/// TabStripStatusDot.tsx / TabStripShared.ts. Foreground orange
/// always wins over background yellow — this view is only
/// instantiated when isRunning is false but runningAgentCount > 0.
private struct InstanceWaitingChildrenDot: View {
    @Environment(\.appTheme) private var theme
    @State private var pulseOpacity: Double = 1.0

    var body: some View {
        Circle()
            .fill(theme.statusWaitingChildren)
            .frame(width: 6, height: 6)
            .opacity(pulseOpacity)
            .onAppear {
                withAnimation(.easeInOut(duration: 1.5).repeatForever(autoreverses: true)) {
                    pulseOpacity = 0.3
                }
            }
    }
}

/// Pulsing pink dot for an instance holding on background bash commands
/// (Bash run_in_background + notify_on_complete). Same pulse as the two dots
/// above; only the fill differs. Uses TabStatusRollup.shellPink so the
/// instance bar and the tab dot render the identical color — the desktop
/// makes the same guarantee via the shared statusBash token.
///
/// Only instantiated when isRunning is false and runningAgentCount is 0:
/// foreground work and dispatched agents both outrank shells, matching the
/// cascade in TabStatusRollup.classify.
private struct InstanceWaitingShellsDot: View {
    @State private var pulseOpacity: Double = 1.0

    var body: some View {
        Circle()
            .fill(TabStatusRollup.shellPink)
            .frame(width: 6, height: 6)
            .opacity(pulseOpacity)
            .onAppear {
                withAnimation(.easeInOut(duration: 1.5).repeatForever(autoreverses: true)) {
                    pulseOpacity = 0.3
                }
            }
    }
}

import SwiftUI

/// Horizontal scrollable bar showing engine instance tabs within an engine tab.
/// Modeled on `TerminalInstanceBar` with simplified behavior.
struct EngineInstanceBar: View {
    let tabId: String
    let instances: [EngineInstanceInfo]
    let activeInstanceId: String
    @Environment(SessionViewModel.self) private var viewModel
    @State private var renamingInstance: EngineInstanceInfo? = nil
    @State private var renameText: String = ""
    /// When non-nil, surfaces a small alert describing the model-fallback
    /// for the corresponding instance — tapped by the user on the ⚠
    /// glyph rendered in `instanceButton`. iOS has no tooltip primitive
    /// equivalent to the desktop's Tooltip component, so an alert is the
    /// idiomatic disclosure surface for this kind of one-shot detail.
    @State private var fallbackDetail: (instanceLabel: String, info: EngineInstanceModelFallback)? = nil
    /// Pending close-confirmation target. The xmark button on a sub-tab
    /// sets this; the `.confirmationDialog` attached to the body reads
    /// it and gates the actual `removeEngineInstance` call behind a
    /// destructive action sheet. We do NOT call `removeEngineInstance`
    /// directly from the tap — closing a sub-tab is destructive (no
    /// history/restore yet) and an inline confirmation right next to
    /// the xmark would let a stray tap or double-tap confirm the close
    /// before the user can react. The action sheet on iPhone surfaces
    /// from the bottom of the screen (popover on iPad), forcing the
    /// user to move their finger to a different region to confirm.
    @State private var pendingCloseInstance: EngineInstanceInfo? = nil

    /// Other engine tabs the active instance can be moved to.
    private var moveTargets: [RemoteTabState] {
        viewModel.tabs.filter { $0.isEngine == true && $0.id != tabId }
    }

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
        .alert("Rename Instance", isPresented: Binding(
            get: { renamingInstance != nil },
            set: { if !$0 { renamingInstance = nil } }
        )) {
            TextField("Name", text: $renameText)
            Button("Cancel", role: .cancel) { renamingInstance = nil }
            Button("Rename") {
                if let inst = renamingInstance, !renameText.trimmingCharacters(in: .whitespaces).isEmpty {
                    viewModel.renameEngineInstance(tabId: tabId, instanceId: inst.id, label: renameText)
                }
                renamingInstance = nil
            }
        } message: {
            Text("Enter a new name for this instance")
        }
        // Model-fallback disclosure alert. Triggered when the user taps
        // the ⚠ glyph rendered next to an instance label in
        // `instanceButton`. Shows the requested vs. fallback model
        // names so the user understands which model is actually running.
        // The indicator clears on its own when the run completes (idle
        // transition propagates through the next snapshot tick).
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
        // Close-instance confirmation. Presented as an action sheet
        // (iPhone) / popover (iPad), which surfaces from a different
        // screen region than the small xmark button — protecting users
        // from double-tap / stray-tap destructive confirms. See the
        // pendingCloseInstance docstring above for the full rationale.
        // The destructive role gives the "Close Instance" button the
        // standard red treatment, and Cancel sits in the iOS-standard
        // cancel position. We re-read pendingCloseInstance inside the
        // destructive button so we don't capture a stale reference if
        // the user changes selection while the sheet is up.
        .confirmationDialog(
            pendingCloseInstance.map { "Close instance \"\($0.label)\"?" } ?? "Close instance?",
            isPresented: Binding(
                get: { pendingCloseInstance != nil },
                set: { if !$0 { pendingCloseInstance = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Close Instance", role: .destructive) {
                if let inst = pendingCloseInstance {
                    viewModel.removeEngineInstance(tabId: tabId, instanceId: inst.id)
                }
                pendingCloseInstance = nil
            }
            Button("Cancel", role: .cancel) {
                pendingCloseInstance = nil
            }
        } message: {
            Text("This will end the engine sub-conversation. There's no undo yet.")
        }
    }

    /// Merges live `statusFields.sessionId` with historical `conversationIds`
    /// for the given engine instance. Returns all IDs (historical first,
    /// live appended if not already present). Matches the desktop
    /// SettingsPopover merge logic.
    private func mergedSessionIds(for instance: EngineInstanceInfo) -> [String] {
        var ids = instance.conversationIds ?? []
        if let current = instance.statusFields?.sessionId, !ids.contains(current) {
            ids.append(current)
        }
        return ids
    }

    @ViewBuilder
    private func instanceButton(_ instance: EngineInstanceInfo) -> some View {
        Button {
            viewModel.selectEngineInstance(tabId: tabId, instanceId: instance.id)
        } label: {
            HStack(spacing: 4) {
                // Per-instance status dot. Priority:
                // 1. waitingState (question → blue, plan-ready → green)
                //    Colors match TabRowView.statusInfo and desktop
                //    EngineStatusBar palette: blue (#4A9EF5) for question,
                //    green for plan-ready.
                // 2. isRunning → pulsing orange (matches tab-list running dot)
                // 3. runningAgentCount > 0 → pulsing yellow (matches the
                //    desktop's statusWaitingChildren). Visually distinct
                //    from the orange foreground dot so multi-instance
                //    users can tell at a glance which sub-conversation
                //    is doing foreground vs. background work.
                // 4. Neither → no dot shown
                if let ws = instance.waitingState {
                    Circle()
                        .fill(ws == "question" ? Color(hex: 0x4A9EF5) : Color.green)
                        .frame(width: 6, height: 6)
                } else if instance.isRunning == true {
                    InstancePulsingDot()
                } else if (instance.runningAgentCount ?? 0) > 0 {
                    InstanceWaitingChildrenDot()
                }
                Image(systemName: "bolt")
                    .font(.caption2)
                Text(instance.label)
                    .font(.caption)
                    .lineLimit(1)

                // Model-fallback indicator. The desktop populates
                // `EngineInstanceInfo.modelFallback` via the snapshot
                // projection (see snapshot.ts) when the engine emitted
                // a ModelFallbackEvent for this instance's most recent
                // run. Rendered as a small ⚠ glyph in the same pill;
                // tapping opens an alert with the requested + fallback
                // model names. The indicator clears on its own when the
                // run goes idle (the desktop's clear-on-idle propagates
                // through the next snapshot tick). Per CLAUDE.md §
                // "Common parity surfaces", iOS shows the same signal
                // as desktop EngineStatusBar.
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

                if instances.count > 1 {
                    Button {
                        // Stage the close — the .confirmationDialog
                        // attached to the body presents an action sheet
                        // / popover the user must explicitly confirm.
                        // See the @State pendingCloseInstance docstring
                        // for rationale (no inline confirm next to a
                        // tiny destructive control).
                        pendingCloseInstance = instance
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 8, weight: .bold))
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(
                RoundedRectangle(cornerRadius: 6)
                    .fill(instance.id == activeInstanceId ? Color.orange.opacity(0.2) : Color.clear)
            )
            .foregroundStyle(instance.id == activeInstanceId ? .primary : .secondary)
        }
        .buttonStyle(.plain)
        .contextMenu {
            // -- Clipboard actions --
            // Merge live sessionId with historical conversationIds (same
            // logic as desktop SettingsPopover). This ensures the button
            // is available for restored tabs before the engine reconnects
            // and for tabs where an extension failed at startup.
            let allIds = mergedSessionIds(for: instance)
            if !allIds.isEmpty {
                Button {
                    UIPasteboard.general.string = allIds.joined(separator: "\n")
                    viewModel.showToast(ToastMessage(style: .success, title: "Session ID copied"))
                } label: {
                    Label("Copy Session ID", systemImage: "doc.on.doc")
                }
                Divider()
            }

            // -- Instance management --
            Button {
                renamingInstance = instance
                renameText = instance.label
            } label: {
                Label("Rename", systemImage: "pencil")
            }
            if !moveTargets.isEmpty {
                Menu {
                    ForEach(moveTargets) { target in
                        Button {
                            viewModel.moveEngineInstance(
                                sourceTabId: tabId,
                                instanceId: instance.id,
                                targetTabId: target.id
                            )
                        } label: {
                            Label(target.customTitle ?? target.title, systemImage: "arrow.right.square")
                        }
                    }
                } label: {
                    Label("Move to", systemImage: "arrow.right.square")
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

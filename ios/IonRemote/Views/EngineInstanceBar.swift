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
                // 3. Neither → no dot shown
                if let ws = instance.waitingState {
                    Circle()
                        .fill(ws == "question" ? Color(hex: 0x4A9EF5) : Color.green)
                        .frame(width: 6, height: 6)
                } else if instance.isRunning == true {
                    InstancePulsingDot()
                }
                Image(systemName: "bolt")
                    .font(.caption2)
                Text(instance.label)
                    .font(.caption)
                    .lineLimit(1)

                if instances.count > 1 {
                    Button {
                        viewModel.removeEngineInstance(tabId: tabId, instanceId: instance.id)
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
            let instanceKey = "\(tabId):\(instance.id)"
            if let sessionId = viewModel.engineStatusFields[instanceKey]?.sessionId {
                Button {
                    UIPasteboard.general.string = sessionId
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

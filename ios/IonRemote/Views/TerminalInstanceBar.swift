import SwiftUI

/// Horizontal scrollable bar showing shell instance tabs within a terminal tab.
struct TerminalInstanceBar: View {
    let tabId: String
    let instances: [TerminalInstanceInfo]
    let activeInstanceId: String
    @Environment(SessionViewModel.self) private var viewModel
    @State private var renamingInstanceId: String?
    @State private var renameText: String = ""

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
        .alert("Rename Shell", isPresented: .init(
            get: { renamingInstanceId != nil },
            set: { if !$0 { renamingInstanceId = nil } }
        )) {
            TextField("Label", text: $renameText)
            Button("Rename") {
                if let id = renamingInstanceId, !renameText.isEmpty {
                    viewModel.renameTerminalInstance(tabId: tabId, instanceId: id, label: renameText)
                }
                renamingInstanceId = nil
            }
            Button("Cancel", role: .cancel) {
                renamingInstanceId = nil
            }
        } message: {
            Text("Enter a new name for this shell tab.")
        }
    }

    @ViewBuilder
    private func instanceButton(_ instance: TerminalInstanceInfo) -> some View {
        let displayLabel = viewModel.terminalInstanceLabel(
            tabId: tabId,
            instanceId: instance.id,
            fallback: instance.label
        )

        Button {
            viewModel.selectTerminalInstance(tabId: tabId, instanceId: instance.id)
        } label: {
            HStack(spacing: 4) {
                Image(systemName: iconForKind(instance.kind))
                    .font(.caption2)
                Text(displayLabel)
                    .font(.caption)
                    .lineLimit(1)

                if instances.count > 1 && !instance.readOnly {
                    Button {
                        viewModel.removeTerminalInstance(tabId: tabId, instanceId: instance.id)
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
                    .fill(instance.id == activeInstanceId ? Color.accentColor.opacity(0.2) : Color.clear)
            )
            .foregroundStyle(instance.id == activeInstanceId ? .primary : .secondary)
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button {
                renameText = displayLabel
                renamingInstanceId = instance.id
            } label: {
                Label("Rename", systemImage: "pencil")
            }
        }
    }

    private func iconForKind(_ kind: String) -> String {
        switch kind {
        case "user": return "terminal"
        case "commit": return "arrow.up.circle"
        case "cli": return "chevron.left.forwardslash.chevron.right"
        default:
            if kind.hasPrefix("tool:") { return "wrench" }
            return "terminal"
        }
    }
}

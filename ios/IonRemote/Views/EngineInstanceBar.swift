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
            Button {
                renamingInstance = instance
                renameText = instance.label
            } label: {
                Label("Rename", systemImage: "pencil")
            }
        }
    }
}

import SwiftUI

/// Horizontal scrollable bar showing engine instance tabs within an engine tab.
/// Modeled on `TerminalInstanceBar` with simplified behavior (no rename, no kind icons).
struct EngineInstanceBar: View {
    let tabId: String
    let instances: [EngineInstanceInfo]
    let activeInstanceId: String
    @Environment(SessionViewModel.self) private var viewModel

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
    }
}

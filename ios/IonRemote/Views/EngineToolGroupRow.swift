import SwiftUI

// MARK: - EngineToolGroupRow

/// Collapsible row that groups consecutive tool messages in the engine conversation.
struct EngineToolGroupRow: View {
    let tools: [EngineMessage]
    @State private var isExpanded = false

    var body: some View {
        VStack(spacing: 0) {
            Button {
                withAnimation(.snappy(duration: 0.2)) { isExpanded.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: compositeIcon)
                        .font(.caption2)
                        .foregroundStyle(compositeColor)
                    Text(summaryText)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Spacer()
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
            }
            .buttonStyle(.plain)

            if isExpanded {
                VStack(spacing: 2) {
                    ForEach(tools) { tool in
                        HStack(spacing: 6) {
                            toolIcon(for: tool)
                            Text(tool.toolName ?? "tool")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                            Spacer()
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 2)
                    }
                }
            }
        }
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    private var compositeIcon: String {
        if tools.contains(where: { $0.toolStatus == "running" }) { return "arrow.triangle.2.circlepath" }
        if tools.contains(where: { $0.toolStatus == "error" }) { return "xmark.circle.fill" }
        return "checkmark.circle.fill"
    }

    private var compositeColor: Color {
        if tools.contains(where: { $0.toolStatus == "running" }) { return .orange }
        if tools.contains(where: { $0.toolStatus == "error" }) { return .red }
        return .green
    }

    private var summaryText: String {
        let names = Set(tools.compactMap(\.toolName))
        if names.count <= 2 { return names.sorted().joined(separator: ", ") }
        return "\(tools.count) tools"
    }

    @ViewBuilder
    private func toolIcon(for tool: EngineMessage) -> some View {
        switch tool.toolStatus {
        case "running":
            ProgressView().scaleEffect(0.6)
        case "completed":
            Image(systemName: "checkmark.circle.fill").font(.caption2).foregroundStyle(.green)
        case "error":
            Image(systemName: "xmark.circle.fill").font(.caption2).foregroundStyle(.red)
        default:
            Image(systemName: "wrench").font(.caption2).foregroundStyle(.secondary)
        }
    }
}

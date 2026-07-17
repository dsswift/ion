import SwiftUI

// MARK: - EngineToolGroupRow

/// Collapsible row that groups consecutive tool messages in the engine conversation.
struct EngineToolGroupRow: View {
    let tools: [Message]
    @State private var isExpanded = false
    @Environment(\.appTheme) private var theme

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
                        .foregroundStyle(theme.textSecondary)
                    Spacer()
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.caption2)
                        .foregroundStyle(theme.textSecondary.opacity(0.5))
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
                                .foregroundStyle(theme.textSecondary)
                            Spacer()
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 2)
                    }
                }
            }
        }
        .background(theme.surfaceElevated.opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    private var compositeIcon: String {
        if tools.contains(where: { $0.toolStatus == .running }) { return "arrow.triangle.2.circlepath" }
        // No running tools — settled == total.
        let summary = toolGroupFailureSummary(tools)
        if summary.failed == 0 { return "checkmark.circle.fill" }
        if summary.failed == summary.total { return "xmark.circle.fill" }
        return "exclamationmark.triangle.fill"
    }

    private var compositeColor: Color {
        if tools.contains(where: { $0.toolStatus == .running }) { return theme.statusRunning }
        // No running tools — settled == total.
        let summary = toolGroupFailureSummary(tools)
        if summary.failed == 0 { return theme.statusDone }
        if summary.failed == summary.total { return theme.statusError }
        return theme.statusWarning
    }

    private var summaryText: String {
        let names = Set(tools.compactMap(\.toolName))
        let base = names.count <= 2 ? names.sorted().joined(separator: ", ") : "\(tools.count) tools"
        let summary = toolGroupFailureSummary(tools)
        // Suppress failure suffix while any tool is still running.
        guard !summary.running, summary.failed > 0 else { return base }
        // No running tools — settled == total.
        if summary.failed == summary.total { return "\(base), all failed" }
        return "\(base), \(summary.failed) failed"
    }

    @ViewBuilder
    private func toolIcon(for tool: Message) -> some View {
        switch tool.toolStatus {
        case .running:
            ProgressView().scaleEffect(0.6)
        case .completed:
            Image(systemName: "checkmark.circle.fill").font(.caption2).foregroundStyle(theme.statusDone)
        case .error:
            Image(systemName: "xmark.circle.fill").font(.caption2).foregroundStyle(theme.statusError)
        case nil:
            Image(systemName: "wrench").font(.caption2).foregroundStyle(theme.textSecondary)
        }
    }
}

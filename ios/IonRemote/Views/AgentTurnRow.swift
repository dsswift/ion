import SwiftUI

// MARK: - AgentTurnRow

/// Renders an agent turn: an optional thinking block above assistant text,
/// followed by a collapsible activity panel (tools) at the bottom. Used by
/// Transcript when the unified turn view setting is active.
///
/// Layout: thinking (top) → assistant messages (middle) → tool panel (bottom).
struct AgentTurnRow: View {
    let tools: [Message]
    let assistantMessages: [Message]
    let isActive: Bool
    let thinking: Message?

    @State private var isExpanded = false
    @Environment(\.appTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            // Thinking block — rendered above assistant text when present.
            if let thinking {
                ThinkingRowView(message: thinking)
            }

            // Assistant text — always visible, not collapsible
            ForEach(assistantMessages) { msg in
                if !msg.content.isEmpty {
                    EngineMessageRow(message: msg)
                }
            }

            // Activity panel — DisclosureGroup, collapsed by default,
            // rendered below assistant text.
            if !tools.isEmpty {
                DisclosureGroup(isExpanded: $isExpanded) {
                    VStack(spacing: 2) {
                        ForEach(tools) { tool in
                            HStack(spacing: 6) {
                                toolIcon(for: tool)
                                Text(toolDescription(
                                    name: tool.toolName ?? "tool",
                                    input: tool.toolInput
                                ))
                                    .font(.caption2)
                                    .foregroundStyle(theme.textSecondary)
                                    .lineLimit(1)
                                    .truncationMode(.tail)
                                Spacer()
                            }
                            .padding(.horizontal, 4)
                            .padding(.vertical, 2)
                        }
                    }
                } label: {
                    HStack(spacing: 6) {
                        if isActive {
                            ProgressView()
                                .scaleEffect(0.6)
                        } else {
                            Image(systemName: compositeIcon)
                                .font(.caption2)
                                .foregroundStyle(compositeColor)
                        }
                        Text(isActive
                            ? "Running tools\u{2026}"
                            : "Used \(tools.count) tool\(tools.count == 1 ? "" : "s")")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(theme.textSecondary)
                    }
                }
                .disclosureGroupStyle(AgentTurnDisclosureStyle(theme: theme))
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
                .background(theme.surfaceElevated.opacity(0.5))
                .clipShape(RoundedRectangle(cornerRadius: 6))
            }
        }
    }

    // MARK: - Helpers

    private var compositeIcon: String {
        if tools.contains(where: { $0.toolStatus == .error }) { return "xmark.circle.fill" }
        return "checkmark.circle.fill"
    }

    private var compositeColor: Color {
        if tools.contains(where: { $0.toolStatus == .error }) { return theme.statusError }
        return theme.statusDone
    }

    @ViewBuilder
    private func toolIcon(for tool: Message) -> some View {
        switch tool.toolStatus {
        case .running:
            ProgressView().scaleEffect(0.6)
        case .completed:
            Image(systemName: "checkmark.circle.fill")
                .font(.caption2)
                .foregroundStyle(theme.statusDone)
        case .error:
            Image(systemName: "xmark.circle.fill")
                .font(.caption2)
                .foregroundStyle(theme.statusError)
        case nil:
            Image(systemName: "wrench")
                .font(.caption2)
                .foregroundStyle(theme.textSecondary)
        }
    }
}

// MARK: - Custom disclosure style

/// Minimal disclosure style that matches the existing EngineToolGroupRow aesthetic.
private struct AgentTurnDisclosureStyle: DisclosureGroupStyle {
    let theme: ThemeManager

    func makeBody(configuration: Configuration) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                withAnimation(.snappy(duration: 0.2)) {
                    configuration.isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 6) {
                    configuration.label
                    Spacer()
                    Image(systemName: configuration.isExpanded ? "chevron.down" : "chevron.right")
                        .font(.caption2)
                        .foregroundStyle(theme.textSecondary.opacity(0.5))
                }
            }
            .buttonStyle(.plain)

            if configuration.isExpanded {
                configuration.content
            }
        }
    }
}

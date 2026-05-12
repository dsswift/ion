import SwiftUI

// MARK: - ToolGroupView

/// Renders a group of consecutive tool-call messages as a single collapsible
/// row, mirroring the desktop's `ToolGroup` component.  For single-tool groups
/// it delegates to the existing `MessageBubble` so the UX is unchanged.
struct ToolGroupView: View {
    let tools: [Message]
    var isTabRunning: Bool = false

    @State private var isExpanded = false
    @State private var forceExpandAll: Bool?

    // MARK: Composite accent color

    private var compositeAccentColor: Color {
        if tools.contains(where: { $0.toolStatus == .running }) {
            return .orange
        } else if tools.contains(where: { $0.toolStatus == .error }) {
            return .red
        } else if tools.allSatisfy({ $0.toolStatus == .completed }) {
            return .green
        } else {
            return Color(.tertiaryLabel)
        }
    }

    // MARK: Body

    var body: some View {
        if tools.count == 1, let single = tools.first {
            // Single tool — render the classic card.
            MessageBubble(message: single)
        } else {
            groupCard
        }
    }

    // MARK: - Group card (2+ tools)

    private var groupCard: some View {
        HStack(spacing: 0) {
            RoundedRectangle(cornerRadius: 1)
                .fill(compositeAccentColor)
                .frame(width: 2)

            VStack(alignment: .leading, spacing: 0) {
                // Header row — always visible.
                Button {
                    withAnimation(IonTheme.snappySpring) {
                        isExpanded.toggle()
                    }
                } label: {
                    HStack(spacing: 8) {
                        compositeStatusIcon

                        if isExpanded {
                            Text("Used \(tools.count) tools")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        } else {
                            Text(toolGroupSummary(tools))
                                .font(.subheadline.monospaced())
                                .foregroundStyle(.primary)
                                .lineLimit(1)
                        }

                        Spacer()

                        Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                }
                .buttonStyle(.plain)

                // Expanded: individual tool rows.
                if isExpanded {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(tools) { tool in
                            ToolItemRow(message: tool, forceExpanded: forceExpandAll)
                        }

                        if tools.count >= 3 {
                            Button {
                                let newState = !(forceExpandAll ?? false)
                                forceExpandAll = newState
                            } label: {
                                Text(forceExpandAll == true ? "Collapse all" : "Expand all")
                                    .font(.caption2)
                                    .foregroundStyle(IonTheme.accent)
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                        }
                    }
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
        }
        .background(Color(.tertiarySystemFill))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .padding(.horizontal, 12)
        .padding(.vertical, 1)
    }

    // MARK: - Composite status icon

    /// Spinner while any tool runs, red X if any errored, green check if all
    /// completed, gray gear otherwise.
    private var compositeStatusIcon: some View {
        Group {
            if tools.contains(where: { $0.toolStatus == .running }) {
                ProgressView()
                    .controlSize(.mini)
            } else if tools.contains(where: { $0.toolStatus == .error }) {
                Image(systemName: "exclamationmark.circle.fill")
                    .foregroundStyle(.orange)
                    .font(.subheadline)
            } else if tools.allSatisfy({ $0.toolStatus == .completed }) {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                    .font(.subheadline)
            } else {
                Image(systemName: "gearshape")
                    .foregroundStyle(.secondary)
                    .font(.subheadline)
            }
        }
    }
}

// MARK: - ToolItemRow

/// A single tool inside an expanded `ToolGroupView`.  Shows name + short
/// description, and can be tapped to reveal input/output.
private struct ToolItemRow: View {
    let message: Message
    var forceExpanded: Bool? = nil
    @State private var isDetailExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(IonTheme.snappySpring) {
                    isDetailExpanded.toggle()
                }
            } label: {
                HStack(spacing: 6) {
                    itemStatusIcon
                        .frame(width: 16)

                    Text(toolDescription(name: message.toolName ?? "Tool",
                                         input: message.toolInput))
                        .font(.caption.monospaced())
                        .foregroundStyle(.primary)
                        .lineLimit(1)

                    Spacer()

                    if isDetailExpanded {
                        Image(systemName: "chevron.up")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 4)
            }
            .buttonStyle(.plain)

            if isDetailExpanded {
                VStack(alignment: .leading, spacing: 4) {
                    if let input = message.toolInput, !input.isEmpty {
                        Text("Input:")
                            .font(.caption.bold())
                            .foregroundStyle(.secondary)
                        Text(input)
                            .font(.caption.monospaced())
                            .textSelection(.enabled)
                            .lineLimit(10)
                    }
                    if !message.content.isEmpty {
                        Text(message.toolStatus == .error ? "Error:" : "Result:")
                            .font(.caption.bold())
                            .foregroundStyle(message.toolStatus == .error ? .red : .secondary)
                        Text(message.content)
                            .font(.caption.monospaced())
                            .textSelection(.enabled)
                            .lineLimit(20)
                            .foregroundStyle(message.toolStatus == .error ? .red : .primary)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 6)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }

        // Subtle separator between items (except the last).
        Divider()
            .padding(.horizontal, 12)
            .onChange(of: forceExpanded) { _, val in
                if let v = val {
                    withAnimation(IonTheme.snappySpring) {
                        isDetailExpanded = v
                    }
                }
            }
    }

    private var itemStatusIcon: some View {
        Group {
            switch message.toolStatus {
            case .running:
                ProgressView()
                    .controlSize(.mini)
            case .completed:
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                    .font(.caption)
            case .error:
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(.red)
                    .font(.caption)
            case nil:
                Image(systemName: "gearshape")
                    .foregroundStyle(.secondary)
                    .font(.caption)
            }
        }
    }
}

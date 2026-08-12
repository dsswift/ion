import SwiftUI

/// Expandable compaction marker in the conversation.
/// Collapsed: single-line pill showing "Context compacted" with stats.
/// Expanded: shows the compaction summary (facts, decisions, files).
struct CompactionRowView: View {
    let message: Message
    @State private var isExpanded = false
    @Environment(\.appTheme) private var theme

    /// Parse the structured [Compaction] content.
    private var parsed: (headline: String, summary: String) {
        let content = message.content
        let parts = content.components(separatedBy: "\n\n")
        let raw = parts.first ?? ""
        let headline = raw
            .replacingOccurrences(of: "[Compaction]", with: "")
            .trimmingCharacters(in: .whitespaces)
        let summary = parts.dropFirst().joined(separator: "\n\n").trimmingCharacters(in: .whitespaces)
        return (headline, summary)
    }

    private var timestamp: String {
        let date = Date(timeIntervalSince1970: (message.timestamp ?? 0) / 1000)
        let fmt = DateFormatter()
        fmt.dateFormat = "h:mm a"
        return fmt.string(from: date)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header row (always visible)
            Button {
                withAnimation(.snappy(duration: 0.15)) { isExpanded.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 8, weight: .semibold)) // design-type: SF Symbol disclosure glyph sized as icon geometry, not text
                        .foregroundStyle(.blue.opacity(0.7))

                    Image(systemName: "arrow.down.right.and.arrow.up.left")
                        .font(.system(size: 10)) // design-type: SF Symbol glyph sized as icon geometry, not text
                        .foregroundStyle(.blue.opacity(0.7))

                    Text("Context compacted")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.blue.opacity(0.85))

                    if !parsed.headline.isEmpty {
                        Text("— \(parsed.headline)")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }

                    Spacer(minLength: 0)

                    Text(timestamp)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                .padding(.horizontal, IonSpace.contentGap)
                .padding(.vertical, IonSpace.compactInset)
            }
            .buttonStyle(.plain)

            // Expanded summary
            if isExpanded {
                VStack(alignment: .leading, spacing: 8) {
                    if parsed.summary.isEmpty {
                        Text("Older context was compacted to free up space.")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    } else {
                        SummarySections(text: parsed.summary)
                    }
                }
                .padding(.horizontal, IonSpace.rowInset)
                .padding(.vertical, IonSpace.compactGap)
                .padding(.leading, IonSpace.hairlineGap)
                .background(
                    RoundedRectangle(cornerRadius: IonRadius.control)
                        .fill(theme.surfaceSecondary)
                )
                .overlay(
                    Rectangle()
                        // A 2pt structural rail marks the expanded-region boundary.
                        // It needs the stronger selection boundary rather than the
                        // hairline `borderSubtle` token.
                        .fill(theme.borderStrong)
                        .frame(width: 2),
                    alignment: .leading
                )
                .padding(.horizontal, IonSpace.contentGap)
                .padding(.bottom, IonSpace.hairlineGap)
            }
        }
    }
}

/// Renders markdown-style summary sections (## headings with bullet items).
private struct SummarySections: View {
    let text: String

    private var sections: [(title: String, items: [String])] {
        text.components(separatedBy: "## ")
            .filter { !$0.isEmpty }
            .map { block in
                let lines = block.components(separatedBy: "\n").filter { !$0.isEmpty }
                let title = lines.first ?? ""
                let items = lines.dropFirst().map { $0 }
                return (title, Array(items))
            }
    }

    var body: some View {
        ForEach(Array(sections.enumerated()), id: \.offset) { _, section in
            VStack(alignment: .leading, spacing: 2) {
                Text(section.title)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.blue.opacity(0.7))
                    .textCase(.uppercase)

                ForEach(Array(section.items.enumerated()), id: \.offset) { _, item in
                    Text(item)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}

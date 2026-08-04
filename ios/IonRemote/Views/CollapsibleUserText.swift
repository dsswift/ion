import SwiftUI

// MARK: - CollapsibleUserText

/// Thresholds shared with the desktop's CollapsibleUserBody (t3code parity):
/// a user message longer than 600 characters or 8 lines collapses by default.
enum CollapsibleUserTextThreshold {
    static let maxLength = 600
    static let maxLines = 8

    static func shouldCollapse(_ text: String) -> Bool {
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return false }
        if text.count > maxLength { return true }
        return text.split(separator: "\n", omittingEmptySubsequences: false).count > maxLines
    }
}

/// Collapsible wrapper for long user-message bubbles. Collapsed state is
/// view-local (`@State`, default collapsed, no persistence). The collapsed
/// body is height-capped with a bottom fade (LinearGradient mask) rather
/// than a hard clip, and a ghost "Show full message"/"Show less" button
/// toggles it. The bubble's context-menu Copy is unaffected: it copies the
/// full `message.content` regardless of collapse.
struct CollapsibleUserText<Content: View>: View {
    let text: String
    @ViewBuilder let content: () -> Content

    @State private var expanded = false

    /// ~11rem at the default body size, matching the desktop cap.
    private let collapsedMaxHeight: CGFloat = 176
    /// ~1.75rem fade band at the bottom of the collapsed view.
    private let fadeHeight: CGFloat = 28

    var body: some View {
        let canCollapse = CollapsibleUserTextThreshold.shouldCollapse(text)
        if !canCollapse {
            content()
        } else {
            VStack(alignment: .trailing, spacing: 4) {
                if expanded {
                    content()
                } else {
                    content()
                        .frame(maxHeight: collapsedMaxHeight, alignment: .top)
                        .clipped()
                        .mask(
                            VStack(spacing: 0) {
                                Rectangle()
                                LinearGradient(
                                    colors: [.black, .clear],
                                    startPoint: .top,
                                    endPoint: .bottom
                                )
                                .frame(height: fadeHeight)
                            }
                        )
                }
                Button {
                    expanded.toggle()
                } label: {
                    Text(expanded ? "Show less" : "Show full message")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(expanded ? [.isSelected] : [])
            }
        }
    }
}

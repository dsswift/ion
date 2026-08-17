import SwiftUI

// MARK: - EngineMessageRow user bubble

/// User-bubble content: the collapsible wrapper (long messages collapse by
/// default, t3code-parity thresholds shared with the desktop's
/// CollapsibleUserBody) around the tinted bubble core. Split from
/// EngineMessageRow.swift at the 600-line size cap, mirroring the
/// SlashBubble/Support extractions.
extension EngineMessageRow {
    @ViewBuilder
    func userBubbleContent(text: String, isBash: Bool) -> some View {
        // Long messages collapse by default (t3code-parity thresholds shared
        // with the desktop's CollapsibleUserBody). The context-menu Copy on
        // the row still copies the full message.content.
        CollapsibleUserText(text: text) {
            VStack(alignment: .leading, spacing: 4) {
                userBubbleCore(text: text, isBash: isBash)
                if let deliveryState = message.deliveryState {
                    promptDeliveryLabel(deliveryState)
                }
            }
        }
    }

    @ViewBuilder
    func deliveryStateLabel(_ state: PromptDeliveryState) -> some View {
        switch state {
        case .queued:
            HStack(spacing: 4) {
                ProgressView()
                    .controlSize(.mini)
                Text("Sending")
                    .font(.caption2)
            }
            .foregroundStyle(.secondary)
        case .accepted:
            EmptyView()
        case .rejected(let error):
            HStack(spacing: 4) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.caption2)
                Text(error ?? "Not delivered")
                    .font(.caption2)
                    .lineLimit(1)
            }
            .foregroundStyle(theme.statusError)
        }
    }

    @ViewBuilder
    private func promptDeliveryLabel(_ state: PromptDeliveryState) -> some View {
        switch state {
        case .queued:
            Label("Waiting for desktop", systemImage: "clock.arrow.circlepath")
                .foregroundStyle(theme.textSecondary)
        case .accepted:
            EmptyView()
        case .rejected(let error):
            Label(error ?? "Desktop rejected message", systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(theme.statusError)
        }
    }

    private func userBubbleCore(text: String, isBash: Bool) -> some View {
        // Markdown, with VERBATIM whitespace. A plain `Text(text)` kept the
        // operator's newlines but rendered `**bold**` and tables as raw source,
        // which diverged from the desktop bubble for the same message. Parsing
        // with `verbatim: true` keeps the paste exact (soft breaks stay
        // newlines, stripped indentation is restored, an indented run stays
        // prose rather than becoming a code card) while a real fence, table, or
        // emphasis renders as markdown — matching the desktop's UserMarkdown.
        MarkdownContentView(
            blocks: MarkdownFormatter.parse(text, verbatim: true),
            blockSpacing: 0,
            blankLineHeight: 20
        )
            .textSelection(.enabled)
            .padding(.leading, 14) // design-geometry: 14pt gap between contentGap and rowInset; off the 4pt ratio scale
            .padding(.trailing, IonSpace.contentGap)
            .padding(.vertical, IonSpace.compactGap)
            .background(
                ZStack {
                    theme.surfaceSecondary
                    theme.userBubbleTint
                }
            )
            .clipShape(RoundedRectangle(cornerRadius: IonRadius.container))
            .overlay(alignment: .leading) {
                Rectangle()
                    .fill(theme.accent)
                    .frame(width: 2.5)
                    .padding(.vertical, IonSpace.hairlineGap)
                    .padding(.leading, 1) // design-geometry: sub-hairline 1pt inset; below the 4pt rhythm floor
            }
            .overlay(
                isBash
                    ? RoundedRectangle(cornerRadius: IonRadius.container)
                        .stroke(theme.statusBash.opacity(0.5), lineWidth: 2)
                    : nil
            )
    }
}

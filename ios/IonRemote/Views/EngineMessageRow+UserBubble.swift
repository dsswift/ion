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
            userBubbleCore(text: text, isBash: isBash)
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
            .padding(.leading, 14)
            .padding(.trailing, 12)
            .padding(.vertical, 8)
            .background(
                ZStack {
                    Color(.tertiarySystemBackground)
                    theme.userBubbleTint
                }
            )
            .clipShape(RoundedRectangle(cornerRadius: IonTheme.Radius.large))
            .overlay(alignment: .leading) {
                Rectangle()
                    .fill(theme.accent)
                    .frame(width: 2.5)
                    .padding(.vertical, 4)
                    .padding(.leading, 1)
            }
            .overlay(
                isBash
                    ? RoundedRectangle(cornerRadius: IonTheme.Radius.large)
                        .stroke(Color(hex: 0xF472B6, opacity: 0.5), lineWidth: 2)
                    : nil
            )
    }
}

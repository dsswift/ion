import SwiftUI

/// Renders an array of `MarkdownBlock` values with GitHub-inspired styling.
/// Each block becomes its own SwiftUI view, enabling backgrounds on code blocks,
/// dividers under headers, accent bars on blockquotes, and proper list indentation.
struct MarkdownContentView: View {
    @Environment(\.appTheme) private var theme
    let blocks: [MarkdownBlock]

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Block dispatch

    @ViewBuilder
    private func blockView(_ block: MarkdownBlock) -> some View {
        switch block {
        case .heading(let level, let text):
            headingView(level: level, text: text)
        case .paragraph(let text):
            paragraphView(text: text)
        case .code(let language, let code):
            codeBlockView(language: language, code: code)
        case .blockQuote(let text):
            blockQuoteView(text: text)
        case .listItem(let ordinal, let ordered, let text):
            listItemView(ordinal: ordinal, ordered: ordered, text: text)
        case .thematicBreak:
            thematicBreakView
        case .table(let headers, let rows, let alignments):
            tableView(
                headers: headers, rows: rows,
                alignments: alignments
            )
        }
    }

    // MARK: - Heading

    private func headingView(
        level: Int,
        text: AttributedString
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(text)
                .font(headingFont(level))
                .fixedSize(horizontal: false, vertical: true)

            if level <= 2 {
                Rectangle()
                    .fill(
                        LinearGradient(
                            colors: [Color(.separator), Color(.separator).opacity(0)],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                    )
                    .frame(height: 0.5)
            }
        }
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: .title.bold()
        case 2: .title2.bold()
        case 3: .title3.bold()
        default: .headline.bold()
        }
    }

    // MARK: - Paragraph

    private func paragraphView(text: AttributedString) -> some View {
        Text(text)
            .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: - Code block

    private func codeBlockView(
        language: String?,
        code: String
    ) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                if let lang = language, !lang.isEmpty {
                    Text(lang)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.tertiary)
                }
                Spacer()
                CodeBlockCopyButton(code: code)
            }
            .padding(.horizontal, 12)
            .padding(.top, 8)
            .padding(.bottom, 4)

            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.system(.callout, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemFill).opacity(0.7))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Block quote

    private func blockQuoteView(text: AttributedString) -> some View {
        HStack(alignment: .top, spacing: 0) {
            RoundedRectangle(cornerRadius: 1.5)
                .fill(theme.accent.opacity(0.6))
                .frame(width: 3.5)

            Text(text)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.leading, 10)
        }
        .padding(.vertical, 4)
    }

    // MARK: - List item

    private func listItemView(
        ordinal: Int,
        ordered: Bool,
        text: AttributedString
    ) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 0) {
            Text(ordered ? "\(ordinal)." : "•")
                .monospacedDigit()
                .frame(width: 24, alignment: .trailing)
                .foregroundStyle(.secondary)

            Text(text)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.leading, 6)
        }
    }

    // MARK: - Table

    private func tableView(
        headers: [AttributedString],
        rows: [[AttributedString]],
        alignments: [TableColumnAlignment]
    ) -> some View {
        let colCount = max(
            headers.count, rows.first?.count ?? 0
        )
        return ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, verticalSpacing: 0) {
                if !headers.isEmpty {
                    GridRow {
                        ForEach(0..<colCount, id: \.self) { col in
                            tableCellContent(
                                text: col < headers.count
                                    ? headers[col] : AttributedString(),
                                alignment: tableAlignment(
                                    col, alignments
                                ),
                                isHeader: true
                            )
                        }
                    }
                }

                ForEach(
                    Array(rows.enumerated()), id: \.offset
                ) { rowIndex, row in
                    GridRow {
                        ForEach(0..<colCount, id: \.self) { col in
                            tableCellContent(
                                text: col < row.count
                                    ? row[col] : AttributedString(),
                                alignment: tableAlignment(
                                    col, alignments
                                ),
                                isHeader: false
                            )
                        }
                    }
                    .background(
                        rowIndex.isMultiple(of: 2)
                            ? Color(.tertiarySystemFill).opacity(0.5)
                            : Color.clear
                    )
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .overlay(
                RoundedRectangle(cornerRadius: 6)
                    .stroke(Color(.separator), lineWidth: 0.5)
            )
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func tableCellContent(
        text: AttributedString,
        alignment: HorizontalAlignment,
        isHeader: Bool
    ) -> some View {
        let textAlign: TextAlignment = switch alignment {
        case .trailing: .trailing
        case .center: .center
        default: .leading
        }
        return Text(text)
            .font(isHeader ? .subheadline.bold() : .subheadline)
            .multilineTextAlignment(textAlign)
            .frame(
                maxWidth: .infinity,
                alignment: Alignment(
                    horizontal: alignment, vertical: .center
                )
            )
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(
                isHeader
                    ? Color(.tertiarySystemFill)
                    : Color.clear
            )
            .overlay(
                Rectangle()
                    .stroke(Color(.separator), lineWidth: 0.5)
            )
    }

    private func tableAlignment(
        _ col: Int,
        _ alignments: [TableColumnAlignment]
    ) -> HorizontalAlignment {
        guard col < alignments.count else { return .leading }
        return switch alignments[col] {
        case .left: .leading
        case .center: .center
        case .right: .trailing
        }
    }

    // MARK: - Thematic break

    private var thematicBreakView: some View {
        Divider()
            .padding(.vertical, 4)
    }
}

// MARK: - Code block copy button

private struct CodeBlockCopyButton: View {
    let code: String
    @State private var copied = false

    var body: some View {
        Button {
            UIPasteboard.general.string = code
            copied = true
            Haptic.light()
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                copied = false
            }
        } label: {
            Image(systemName: copied ? "checkmark" : "doc.on.doc")
                .font(.caption2)
                .foregroundStyle(copied ? Color.green : Color(.tertiaryLabel))
                .frame(width: 24, height: 24)
                .contentTransition(.symbolEffect(.replace))
        }
        .buttonStyle(.plain)
    }
}

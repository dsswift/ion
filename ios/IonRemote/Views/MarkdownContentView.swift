import SwiftUI

/// Renders an array of `MarkdownBlock` values with GitHub-inspired styling.
/// Each block becomes its own SwiftUI view, enabling backgrounds on code blocks,
/// dividers under headers, accent bars on blockquotes, and proper list indentation.
struct MarkdownContentView: View {
    @Environment(\.appTheme) private var theme
    let blocks: [MarkdownBlock]
    /// Standard markdown uses editorial spacing between blocks. Verbatim user
    /// messages reconstruct spacing from source positions, so implicit spacing
    /// must be zero or every block gets vertical space the operator did not type.
    var blockSpacing: CGFloat = 16
    /// Font-relative height used for one reconstructed source blank line.
    var blankLineHeight: CGFloat = 20
    /// When set, `ion-file://` links emitted by the formatter's file-path
    /// detection (see MarkdownFormatter + FilePathDetector) route here with
    /// the decoded path; every other URL falls through to the system.
    var onOpenFile: ((String) -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: blockSpacing) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .environment(\.openURL, OpenURLAction { url in
            if let path = FilePathDetector.path(from: url) {
                if let onOpenFile {
                    onOpenFile(path)
                } else {
                    // No handler at this call site (compact/engine rows) —
                    // swallow rather than hand an internal scheme to iOS.
                    DiagnosticLog.log("file link tapped with no handler", tag: "markdown", fields: [
                        "path": path
                    ])
                }
                return .handled
            }
            return .systemAction
        })
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
        case .blankLines(let count):
            Color.clear
                .frame(height: CGFloat(count) * blankLineHeight)
                .accessibilityHidden(true)
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
                    .fill(theme.borderSubtle)
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
                    Image(systemName: FileIcon.symbol(forExtension: lang.lowercased()))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                    Text(lang)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.tertiary)
                }
                Spacer()
                CodeBlockCopyButton(code: code)
            }
            .padding(.horizontal, IonSpace.contentGap)
            .padding(.top, IonSpace.compactGap)
            .padding(.bottom, IonSpace.hairlineGap)

            HighlightedCodeView(code: code, language: language)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.codeBg)
        .clipShape(RoundedRectangle(cornerRadius: IonRadius.control))
    }

    // MARK: - Block quote

    private func blockQuoteView(text: AttributedString) -> some View {
        HStack(alignment: .top, spacing: 0) {
            RoundedRectangle(cornerRadius: 1.5) // design-geometry: hairline rounding on a thin blockquote rule; below the control radius floor
                .fill(theme.accent.opacity(0.6))
                .frame(width: 3.5)

            Text(text)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.leading, 10) // design-geometry: 10pt gap between compactGap and contentGap; off the 4pt ratio scale
        }
        .padding(.vertical, IonSpace.hairlineGap)
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
                .padding(.leading, IonSpace.compactInset)
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
            .clipShape(RoundedRectangle(cornerRadius: IonRadius.control))
            .overlay(
                RoundedRectangle(cornerRadius: IonRadius.control)
                    .stroke(theme.borderSubtle, lineWidth: 0.5)
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
            .padding(.horizontal, 10) // design-geometry: 10pt gap between compactGap and contentGap; off the 4pt ratio scale
            .padding(.vertical, 7) // design-geometry: 7pt nudge; off the 4pt ratio scale
            .background(
                isHeader
                    ? Color(.tertiarySystemFill)
                    : Color.clear
            )
            .overlay(
                Rectangle()
                    .stroke(theme.borderSubtle, lineWidth: 0.5)
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
            .padding(.vertical, IonSpace.hairlineGap)
    }
}

// MARK: - Code block copy button

private struct CodeBlockCopyButton: View {
    @Environment(\.appTheme) private var theme
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
                .foregroundStyle(copied ? theme.statusDone : Color(.tertiaryLabel))
                .frame(width: 24, height: 24)
                .contentTransition(.symbolEffect(.replace))
        }
        .buttonStyle(.plain)
    }
}

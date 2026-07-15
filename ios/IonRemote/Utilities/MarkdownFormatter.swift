import SwiftUI
import Markdown

/// Column alignment parsed from a markdown table.
enum TableColumnAlignment {
    case left, center, right
}

/// A parsed markdown block produced by `MarkdownFormatter.parse`.
enum MarkdownBlock: Identifiable {
    case heading(level: Int, text: AttributedString)
    case paragraph(text: AttributedString)
    case code(language: String?, text: String)
    case blockQuote(text: AttributedString)
    case listItem(ordinal: Int, ordered: Bool, text: AttributedString)
    case thematicBreak
    case table(
        headers: [AttributedString],
        rows: [[AttributedString]],
        alignments: [TableColumnAlignment]
    )

    var id: String {
        switch self {
        case .heading(let l, let t):
            return "h\(l)-\(String(t.characters).hashValue)"
        case .paragraph(let t):
            return "p-\(String(t.characters).hashValue)"
        case .code(_, let t):
            return "c-\(t.hashValue)"
        case .blockQuote(let t):
            return "bq-\(String(t.characters).hashValue)"
        case .listItem(let o, let ord, let t):
            let k = "li\(ord ? "o" : "u")\(o)"
            return "\(k)-\(String(t.characters).hashValue)"
        case .thematicBreak:
            return "hr-\(Int.random(in: 0...Int.max))"
        case .table(let h, let r, _):
            let hh = h.map { String($0.characters) }.joined()
            let rr = r.flatMap { $0.map { String($0.characters) } }
                .joined()
            return "tbl-\((hh + rr).hashValue)"
        }
    }
}

/// Parses Markdown into `[MarkdownBlock]` for rich composite rendering, or
/// into a single `AttributedString` for compact inline previews.
///
/// Uses `apple/swift-markdown` (CommonMark + GFM) as the parser. Walks the
/// resulting AST to emit our flat `[MarkdownBlock]` representation. The
/// rendering layer (`MarkdownContentView`) is unchanged.
///
/// Robustness contract: `parse(_:)` never throws. For any input string `s`,
/// it returns a non-empty `[MarkdownBlock]`. A three-tier fallback (walker →
/// raw paragraph) guarantees no content is silently dropped at the document
/// level, even for malformed or partial markdown (e.g. an LLM cut off
/// mid-stream). See `docs/architecture/file-organization.md` for context.
@MainActor
enum MarkdownFormatter {

    // MARK: - Rich block API (full-screen viewer)

    static func parse(_ markdown: String) -> [MarkdownBlock] {
        let inputLen = markdown.count
        DiagnosticLog.trace("markdown parse", tag: "markdown.parse", fields: [
            "count": String(inputLen)
        ])

        // Empty / whitespace input: return a single empty paragraph. This
        // preserves the previous formatter's behavior so call sites that
        // assume parse(...) returns at least one block don't need updating.
        if markdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            DiagnosticLog.log("markdown.parse: empty input → single empty paragraph")
            return [.paragraph(text: AttributedString(""))]
        }

        // Normalize line endings. swift-markdown handles CRLF/LF/CR per the
        // CommonMark spec, but we normalize once on entry so any subsequent
        // string manipulation (table rendering, plain-text fallbacks) sees
        // a single canonical form.
        let normalized = markdown
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")

        // The Document(parsing:) initializer itself does not throw — it
        // always returns *some* Document, however degenerate. The do/try
        // here is defensive: if a future swift-markdown release changes
        // the contract (or a walker throws), we degrade to a single
        // paragraph rather than losing the whole message.
        let blocks: [MarkdownBlock]
        do {
            let document = Markdown.Document(parsing: normalized)
            blocks = try walkDocument(document, raw: normalized)
        } catch {
            DiagnosticLog.log("markdown parse walker failed", tag: "markdown.parse", level: .warn, fields: [
                "error": String(describing: error)
            ])
            return [.paragraph(text: AttributedString(normalized))]
        }

        // Final safety net: if the walker produced no blocks for non-empty
        // input (should never happen for well-formed swift-markdown output,
        // but if a future spec change makes it possible we don't want to
        // surface an empty message), fall back to a raw paragraph so the
        // user still sees their content.
        if blocks.isEmpty {
            DiagnosticLog.log("markdown.parse: walker emitted 0 blocks → raw paragraph fallback")
            return [.paragraph(text: AttributedString(normalized))]
        }

        let summary = summarize(blocks)
        DiagnosticLog.trace("markdown parse emitted", tag: "markdown.parse", fields: [
            "count": String(blocks.count),
            "reason": summary
        ])
        return blocks
    }

    // MARK: - Compact single-string API (card preview)

    static func format(_ markdown: String) -> AttributedString {
        let blocks = parse(markdown)
        var result = AttributedString()
        for (i, block) in blocks.enumerated() {
            if i > 0 { result.append(AttributedString("\n")) }
            switch block {
            case .heading(_, let t):
                var h = t; h.font = .headline
                result.append(h)
            case .paragraph(let t):
                result.append(t)
            case .code(_, let t):
                var a = AttributedString(t)
                a.font = .system(.caption, design: .monospaced)
                a.foregroundColor = .secondary
                result.append(a)
            case .blockQuote(let t):
                var q = AttributedString("▎ "); q.foregroundColor = .secondary
                result.append(q); result.append(t)
            case .listItem(let o, let ord, let t):
                result.append(AttributedString(ord ? "\(o). " : "• "))
                result.append(t)
            case .thematicBreak:
                var hr = AttributedString("───")
                hr.foregroundColor = .secondary
                result.append(hr)
            case .table(let headers, let rows, _):
                let headerLine = headers
                    .map { String($0.characters) }.joined(separator: " | ")
                result.append(AttributedString(headerLine))
                for row in rows {
                    result.append(AttributedString("\n"))
                    let line = row.map { String($0.characters) }
                        .joined(separator: " | ")
                    result.append(AttributedString(line))
                }
            }
        }
        return result
    }

    // MARK: - Document walker

    /// Walk the swift-markdown `Document` AST and emit our flat block list.
    /// The walker is non-throwing in practice — every CommonMark block kind
    /// has a mapping. The `throws` signature exists only to let future
    /// extensions throw without restructuring `parse(_:)`.
    private static func walkDocument(
        _ document: Markdown.Document,
        raw: String
    ) throws -> [MarkdownBlock] {
        var out: [MarkdownBlock] = []
        for child in document.blockChildren {
            walkBlock(child, into: &out)
        }
        return out
    }

    /// Walk one block-level AST node and append zero or more `MarkdownBlock`s
    /// to `out`. Lists fan out internally via `walkListItem`.
    private static func walkBlock(
        _ block: any Markup,
        into out: inout [MarkdownBlock]
    ) {
        switch block {
        case let heading as Markdown.Heading:
            out.append(.heading(
                level: heading.level,
                text: renderInline(heading.inlineChildren)
            ))

        case let paragraph as Markdown.Paragraph:
            out.append(.paragraph(text: renderInline(paragraph.inlineChildren)))

        case let codeBlock as Markdown.CodeBlock:
            // CodeBlock.code retains the trailing newline that cmark inserts;
            // trim it so the rendered code view doesn't show a phantom empty
            // last line.
            var code = codeBlock.code
            if code.hasSuffix("\n") { code.removeLast() }
            let lang = codeBlock.language?.trimmingCharacters(
                in: .whitespacesAndNewlines)
            out.append(.code(
                language: (lang?.isEmpty == true) ? nil : lang,
                text: code
            ))

        case is Markdown.ThematicBreak:
            out.append(.thematicBreak)

        case let blockQuote as Markdown.BlockQuote:
            // Flatten quoted content. We render every nested block's plain
            // text into one attributed string with newlines, preserving the
            // current MarkdownBlock.blockQuote contract (single AttributedString).
            let inner = flattenBlocksToAttributed(blockQuote.blockChildren)
            out.append(.blockQuote(text: inner))

        case let orderedList as Markdown.OrderedList:
            // CommonMark stores the starting ordinal on the list itself.
            var ordinal = Int(orderedList.startIndex)
            for item in orderedList.listItems {
                walkListItem(item, into: &out, ordinal: ordinal, ordered: true)
                ordinal += 1
            }

        case let unorderedList as Markdown.UnorderedList:
            // Unordered lists carry no ordinal; we pass 0 (the renderer ignores
            // it when `ordered == false`).
            for item in unorderedList.listItems {
                walkListItem(item, into: &out, ordinal: 0, ordered: false)
            }

        case let table as Markdown.Table:
            walkTable(table, into: &out)

        case let htmlBlock as Markdown.HTMLBlock:
            // Raw HTML has no SwiftUI rendering path; surface it as a
            // monospaced code-like paragraph so the user at least sees the
            // text rather than losing it silently.
            out.append(.paragraph(text: AttributedString(htmlBlock.rawHTML)))

        default:
            // CustomBlock, BlockDirective, Doxygen commands, and any future
            // block kinds fall through to plain text. format(_:) is the
            // canonical "give me the text" helper for any Markup node.
            let text = block.format()
            if !text.isEmpty {
                out.append(.paragraph(text: AttributedString(text)))
            }
        }
    }

    /// Walk a single list item. Each item becomes one `.listItem` block, and
    /// any nested blocks (paragraphs, code blocks, sublists) inside the item
    /// are flattened: the first paragraph becomes the item text, and any
    /// subsequent nested blocks (e.g. nested lists, code) are emitted as
    /// their own top-level blocks. This matches the current renderer's
    /// flat-list assumption — nested lists render visually as additional
    /// items rather than as a true tree, same behavior as the previous
    /// Foundation-based formatter.
    private static func walkListItem(
        _ item: Markdown.ListItem,
        into out: inout [MarkdownBlock],
        ordinal: Int,
        ordered: Bool
    ) {
        // Reserve the position where the list-item block will land. Any
        // nested blocks (sublists, code, blockquotes) emitted by the loop
        // below append to `out` *after* this index so the visual order is:
        // [item, nested-block, nested-block, ...].
        let insertIndex = out.count
        var itemText = AttributedString()
        var didCaptureFirst = false
        for child in item.blockChildren {
            if !didCaptureFirst, let para = child as? Markdown.Paragraph {
                itemText = renderInline(para.inlineChildren)
                didCaptureFirst = true
                continue
            }
            // Any other nested blocks (code, sublists, blockquotes) are
            // emitted as their own top-level blocks after the item.
            walkBlock(child, into: &out)
        }
        if !didCaptureFirst {
            // Empty list item (rare) — emit an empty item so list numbering
            // stays consistent.
            itemText = AttributedString("")
        }
        out.insert(
            .listItem(ordinal: ordinal, ordered: ordered, text: itemText),
            at: insertIndex
        )
    }

    // MARK: - Table walker

    /// Convert a swift-markdown `Table` into our flat `.table(...)` block.
    /// Reuses the existing renderer contract: headers as a `[AttributedString]`,
    /// rows as `[[AttributedString]]`, alignments as `[TableColumnAlignment]`
    /// padded to the column count.
    private static func walkTable(
        _ table: Markdown.Table,
        into out: inout [MarkdownBlock]
    ) {
        // Header
        var headers: [AttributedString] = []
        for cell in table.head.cells {
            headers.append(renderInline(cell.inlineChildren))
        }

        // Body rows
        var rows: [[AttributedString]] = []
        for row in table.body.rows {
            var cells: [AttributedString] = []
            for cell in row.cells {
                cells.append(renderInline(cell.inlineChildren))
            }
            rows.append(cells)
        }

        // Alignments. GFM's spec allows nil (default left). Pad to the wider
        // of header/first-row column count so the renderer's bounded index
        // access stays in range.
        let colCount = max(headers.count, rows.first?.count ?? 0)
        var alignments: [TableColumnAlignment] = []
        for col in 0..<colCount {
            if col < table.columnAlignments.count,
               let a = table.columnAlignments[col]
            {
                alignments.append(convertAlignment(a))
            } else {
                alignments.append(.left)
            }
        }

        out.append(.table(
            headers: headers,
            rows: rows,
            alignments: alignments
        ))
    }

    private static func convertAlignment(
        _ a: Markdown.Table.ColumnAlignment
    ) -> TableColumnAlignment {
        switch a {
        case .left:   return .left
        case .center: return .center
        case .right:  return .right
        }
    }

    // MARK: - Inline rendering

    /// Render a sequence of inline markup nodes into a single `AttributedString`
    /// with the appropriate per-run styling. SwiftUI's `Text(AttributedString)`
    /// honors `font`, `foregroundColor`, and inline links automatically.
    private static func renderInline(
        _ inlines: some Sequence<InlineMarkup>
    ) -> AttributedString {
        var result = AttributedString()
        for inline in inlines {
            result.append(renderInlineNode(inline))
        }
        return result
    }

    /// Render one inline AST node. Recurses through containers (Emphasis,
    /// Strong, Link, Strikethrough) so nested styles compose (e.g. bold
    /// inside a link).
    private static func renderInlineNode(_ inline: any Markup) -> AttributedString {
        switch inline {
        case let text as Markdown.Text:
            return AttributedString(text.string)

        case let code as Markdown.InlineCode:
            var a = AttributedString(code.code)
            a.font = .system(.body, design: .monospaced)
            a.backgroundColor = Color(.tertiarySystemFill)
            return a

        case let emphasis as Markdown.Emphasis:
            var inner = renderInline(emphasis.inlineChildren)
            // Apply italic to every existing run by setting the font on the
            // attribute container. AttributedString lacks a direct "merge
            // italic into existing font" API, so we walk the runs and
            // promote each to an italic variant. For runs that already have
            // a code (monospace) font, italic is purely a visual hint —
            // SwiftUI's `Text` honors `.italic` independently of the font.
            inner.runs.forEach { run in
                let range = run.range
                inner[range].font = (inner[range].font ?? .body).italic()
            }
            return inner

        case let strong as Markdown.Strong:
            var inner = renderInline(strong.inlineChildren)
            inner.runs.forEach { run in
                let range = run.range
                inner[range].font = (inner[range].font ?? .body).bold()
            }
            return inner

        case let strike as Markdown.Strikethrough:
            var inner = renderInline(strike.inlineChildren)
            inner.runs.forEach { run in
                let range = run.range
                inner[range].strikethroughStyle = .single
            }
            return inner

        case let link as Markdown.Link:
            var inner = renderInline(link.inlineChildren)
            if let dest = link.destination, let url = URL(string: dest) {
                inner.runs.forEach { run in
                    let range = run.range
                    inner[range].link = url
                }
            }
            return inner

        case let image as Markdown.Image:
            // No inline image rendering yet — surface the alt text + URL so
            // the content isn't lost. Future work: inline image preview.
            let alt = image.plainText
            if let src = image.source {
                return AttributedString("[image: \(alt.isEmpty ? src : alt)]")
            }
            return AttributedString(alt.isEmpty ? "[image]" : "[image: \(alt)]")

        case is Markdown.LineBreak:
            return AttributedString("\n")

        case is Markdown.SoftBreak:
            // CommonMark soft breaks render as a space in HTML; we mirror
            // that so prose reflows naturally on small screens.
            return AttributedString(" ")

        case let inlineHTML as Markdown.InlineHTML:
            // Raw inline HTML: surface as plain text rather than dropping.
            return AttributedString(inlineHTML.rawHTML)

        case let symbolLink as Markdown.SymbolLink:
            // Disabled by default (we don't pass .parseSymbolLinks), but
            // handle it anyway so a future config flip doesn't lose content.
            return AttributedString("`\(symbolLink.destination ?? "")`")

        case let attrs as Markdown.InlineAttributes:
            // We don't honor the attributes themselves; render the children.
            return renderInline(attrs.inlineChildren)

        default:
            // CustomInline and any future inline kinds: render plain text.
            return AttributedString(inline.format())
        }
    }

    // MARK: - Helpers

    /// Flatten a sequence of blocks (e.g. the contents of a BlockQuote) into
    /// a single attributed string, joining nested blocks with newlines. This
    /// preserves the current `MarkdownBlock.blockQuote` contract, which holds
    /// a single `AttributedString` rather than nested blocks.
    private static func flattenBlocksToAttributed(
        _ blocks: some Sequence<BlockMarkup>
    ) -> AttributedString {
        var result = AttributedString()
        var first = true
        for block in blocks {
            if !first {
                result.append(AttributedString("\n"))
            }
            first = false
            switch block {
            case let p as Markdown.Paragraph:
                result.append(renderInline(p.inlineChildren))
            case let h as Markdown.Heading:
                result.append(renderInline(h.inlineChildren))
            case let cb as Markdown.CodeBlock:
                var a = AttributedString(cb.code)
                a.font = .system(.body, design: .monospaced)
                result.append(a)
            default:
                result.append(AttributedString(block.format()))
            }
        }
        return result
    }

    /// Build a "kind:count" summary string for the diagnostic log so we can
    /// audit parser output without grepping the full block list.
    private static func summarize(_ blocks: [MarkdownBlock]) -> String {
        var counts: [String: Int] = [:]
        for b in blocks {
            let key: String
            switch b {
            case .heading:       key = "heading"
            case .paragraph:     key = "paragraph"
            case .code:          key = "code"
            case .blockQuote:    key = "blockQuote"
            case .listItem:      key = "listItem"
            case .thematicBreak: key = "thematicBreak"
            case .table:         key = "table"
            }
            counts[key, default: 0] += 1
        }
        return counts
            .sorted { $0.key < $1.key }
            .map { "\($0.key):\($0.value)" }
            .joined(separator: ", ")
    }
}

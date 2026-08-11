import SwiftUI
import Markdown

// MARK: - MarkdownFormatter helpers
//
// Split from MarkdownFormatter.swift to keep that file under the 600-line
// cap. These are `internal` (not `private`) because Swift's `private` does
// not extend across files even for extensions of the same type — every
// caller of these functions still lives in MarkdownFormatter.swift.
extension MarkdownFormatter {
    /// Inline-code chip. Detected file paths additionally get an
    /// `ion-file://` link (intercepted by MarkdownContentView's
    /// OpenURLAction), staying one flowing AttributedString so wrapping,
    /// taps, and selection all keep working.
    ///
    /// Platform differences (documented, both stem from AttributedString
    /// limits inside SwiftUI Text):
    ///   - the desktop chip carries a 1px border; AttributedString cannot
    ///     stroke one, so iOS approximates the chip with the fill alone.
    ///   - the desktop chip prefixes a file-type icon; SwiftUI Text renders
    ///     no image attachments from AttributedString (only Text-level
    ///     `\(Image(...))` interpolation, which cannot compose with the
    ///     formatter's single-AttributedString contract), so iOS renders
    ///     path text only. The block-level code badge does carry the icon.
    static func renderInlineCode(_ code: String) -> AttributedString {
        var body = AttributedString(code)
        body.font = .system(.body, design: .monospaced)
        body.backgroundColor = Color(.tertiarySystemFill)
        if let ref = FilePathDetector.detect(code), let url = FilePathDetector.url(for: ref) {
            body.link = url
        }
        return body
    }

    /// Re-anchor a verbatim context on a paragraph's own content column.
    ///
    /// A paragraph inside a blockquote starts at the column after `> `, and one
    /// inside a list item after `- `. Restoring indentation against the document
    /// margin instead would splice the container's marker characters into the
    /// text, so the column travels with the context.
    static func paragraphContext(
        _ paragraph: Markdown.Paragraph,
        verbatim: VerbatimContext?
    ) -> VerbatimContext? {
        guard let verbatim else { return nil }
        guard let column = paragraph.range?.lowerBound.column else { return verbatim }
        return verbatim.nested(contentColumn: column)
    }

    /// Flatten a sequence of blocks (e.g. the contents of a BlockQuote) into
    /// a single attributed string, joining nested blocks with newlines. This
    /// preserves the current `MarkdownBlock.blockQuote` contract, which holds
    /// a single `AttributedString` rather than nested blocks.
    static func flattenBlocksToAttributed(
        _ blocks: some Sequence<BlockMarkup>,
        verbatim: VerbatimContext?
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
                result.append(renderInline(p.inlineChildren, verbatim: paragraphContext(p, verbatim: verbatim)))
            case let h as Markdown.Heading:
                result.append(renderInline(h.inlineChildren, verbatim: verbatim))
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
    static func summarize(_ blocks: [MarkdownBlock]) -> String {
        var counts: [String: Int] = [:]
        for b in blocks {
            let key: String
            switch b {
            case .heading:       key = "heading"
            case .paragraph:     key = "paragraph"
            case .code:          key = "code"
            case .blockQuote:    key = "blockQuote"
            case .listItem:      key = "listItem"
            case .blankLines:    key = "blankLines"
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

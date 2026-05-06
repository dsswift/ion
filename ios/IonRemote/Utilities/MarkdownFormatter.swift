import SwiftUI

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
/// Uses Apple's `AttributedString` with `.full` interpretation and walks the
/// `presentationIntent` runs to classify blocks. No third-party dependency.
@MainActor
enum MarkdownFormatter {

    // MARK: - Rich block API (full-screen viewer)

    static func parse(_ markdown: String) -> [MarkdownBlock] {
        guard let parsed = try? AttributedString(
            markdown: markdown,
            options: .init(
                allowsExtendedAttributes: true,
                interpretedSyntax: .full,
                failurePolicy: .returnPartiallyParsedIfPossible
            )
        ) else {
            return [.paragraph(text: fallback(markdown))]
        }

        var blocks: [MarkdownBlock] = []
        var accum = AttributedString()
        var currentKind: BlockKind?
        var tableCells: [TableCellEntry] = []

        for run in parsed.runs {
            let segment = AttributedString(parsed[run.range])
            let kind = classify(run.presentationIntent)

            if kind != currentKind {
                flush(
                    currentKind, text: &accum,
                    into: &blocks, tableCells: &tableCells
                )
                currentKind = kind
            }
            accum.append(segment)
        }
        flush(
            currentKind, text: &accum,
            into: &blocks, tableCells: &tableCells
        )
        flushTable(&tableCells, into: &blocks)
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

    // MARK: - Block classification

    /// Internal block kind used to group consecutive runs that belong to
    /// the same logical block. Equality is by kind + identity so that
    /// two distinct paragraphs are flushed separately.
    private enum BlockKind: Equatable {
        case heading(Int, Int)      // level, identity
        case paragraph(Int)         // identity
        case code(String?, Int)     // language, identity
        case blockQuote(Int)        // identity
        case listItem(Int, Bool, Int) // ordinal, ordered, identity
        case thematicBreak(Int)     // identity
        case tableCell(Int, Bool, Int, Int, Int) // tableID, isHeader, row, col, cellID
        case unknown
    }

    private static func classify(
        _ intent: PresentationIntent?
    ) -> BlockKind {
        guard let intent else { return .unknown }

        // Table detection — components contain the full nesting path:
        // [.table(columns:), .tableHeaderRow/.tableRow(rowIndex:),
        //  .tableCell(columnIndex:)]
        var tableID: Int?
        var isHeader = false
        var rowIndex = -1
        var colIndex = 0
        var cellID = 0

        for component in intent.components {
            switch component.kind {
            case .table:
                tableID = component.identity
            case .tableHeaderRow:
                isHeader = true
                rowIndex = -1
            case .tableRow(let idx):
                isHeader = false
                rowIndex = idx
            case .tableCell(let col):
                colIndex = col
                cellID = component.identity
            default:
                break
            }
        }
        if let tid = tableID {
            return .tableCell(tid, isHeader, rowIndex, colIndex, cellID)
        }

        for component in intent.components {
            switch component.kind {
            case .header(let level):
                return .heading(level, component.identity)
            case .codeBlock(let lang):
                return .code(lang, component.identity)
            case .blockQuote:
                return .blockQuote(component.identity)
            case .thematicBreak:
                return .thematicBreak(component.identity)
            case .listItem(let ordinal):
                let ordered = intent.components.contains {
                    $0.kind == .orderedList
                }
                return .listItem(ordinal, ordered, component.identity)
            default:
                continue
            }
        }
        // Fall back to paragraph, keyed by the outermost identity.
        let pid = intent.components.last?.identity ?? 0
        return .paragraph(pid)
    }

    // MARK: - Table cell entry

    private struct TableCellEntry {
        let tableID: Int
        let isHeader: Bool
        let rowIndex: Int
        let columnIndex: Int
        let text: AttributedString
    }

    // MARK: - Flushing

    private static func flush(
        _ kind: BlockKind?,
        text: inout AttributedString,
        into blocks: inout [MarkdownBlock],
        tableCells: inout [TableCellEntry]
    ) {
        guard let kind, !text.characters.isEmpty else {
            text = AttributedString()
            return
        }
        let captured = text
        text = AttributedString()

        if case .tableCell(let tid, let hdr, let row, let col, _) = kind {
            // Flush any pending table from a *different* table first.
            if let first = tableCells.first, first.tableID != tid {
                flushTable(&tableCells, into: &blocks)
            }
            tableCells.append(TableCellEntry(
                tableID: tid, isHeader: hdr,
                rowIndex: row, columnIndex: col, text: captured
            ))
            return
        }

        // Transitioning away from table → assemble pending table.
        flushTable(&tableCells, into: &blocks)

        switch kind {
        case .heading(let level, _):
            blocks.append(.heading(level: level, text: captured))
        case .paragraph:
            blocks.append(.paragraph(text: captured))
        case .code(let lang, _):
            blocks.append(.code(language: lang, text: plain(captured)))
        case .blockQuote:
            blocks.append(.blockQuote(text: captured))
        case .listItem(let ordinal, let ordered, _):
            blocks.append(.listItem(
                ordinal: ordinal, ordered: ordered, text: captured
            ))
        case .thematicBreak:
            blocks.append(.thematicBreak)
        case .tableCell:
            break // handled above
        case .unknown:
            blocks.append(.paragraph(text: captured))
        }
    }

    // MARK: - Table assembly

    private static func flushTable(
        _ cells: inout [TableCellEntry],
        into blocks: inout [MarkdownBlock]
    ) {
        guard !cells.isEmpty else { return }
        blocks.append(assembleTable(cells))
        cells.removeAll()
    }

    private static func assembleTable(
        _ cells: [TableCellEntry]
    ) -> MarkdownBlock {
        let headerCells = cells.filter(\.isHeader)
            .sorted { $0.columnIndex < $1.columnIndex }
        let headers = headerCells.map(\.text)

        let bodyCells = cells.filter { !$0.isHeader }
        let grouped = Dictionary(grouping: bodyCells) { $0.rowIndex }
        let rows = grouped.keys.sorted().map { rowIdx in
            grouped[rowIdx]!
                .sorted { $0.columnIndex < $1.columnIndex }
                .map(\.text)
        }

        let colCount = max(
            headers.count,
            rows.first?.count ?? 0
        )
        let alignments = Array(
            repeating: TableColumnAlignment.left, count: colCount
        )

        return .table(
            headers: headers, rows: rows, alignments: alignments
        )
    }

    // MARK: - Helpers

    private static func plain(_ attr: AttributedString) -> String {
        String(attr.characters)
    }

    private static func fallback(
        _ markdown: String
    ) -> AttributedString {
        if let inline = try? AttributedString(
            markdown: markdown,
            options: .init(
                interpretedSyntax: .inlineOnlyPreservingWhitespace
            )
        ) {
            return inline
        }
        return AttributedString(markdown)
    }
}

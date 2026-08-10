import Foundation
import Markdown

/// Verbatim-whitespace support for `MarkdownFormatter`.
///
/// A USER message must render exactly as it was typed — a pasted console
/// transcript, a stack trace, indented YAML — while still rendering markdown.
/// CommonMark discards the whitespace that matters for that in two places:
///
///   1. A single newline inside a paragraph is a "soft break", which renders as
///      a SPACE per the CommonMark spec (see `MarkdownFormatter`'s default
///      `SoftBreak` handling). Correct for prose, wrong for a paste.
///   2. Leading whitespace on a continuation line is stripped by the block
///      parser before it reaches the AST, so it cannot be recovered from the
///      parsed nodes at all — only from the original source.
///
/// Plus a third, different in kind: a run indented four or more spaces parses as
/// an indented code block, so one accidentally-indented line inside an otherwise
/// plain paste becomes a code card sitting beside prose.
///
/// This context carries the source text needed to undo (2) and (3). Its presence
/// is also what selects verbatim behaviour for (1) — `MarkdownFormatter` walks
/// with `verbatim: nil` for assistant content, where collapsing a soft break is
/// the correct reading.
///
/// Mirrors the desktop's `remarkPreserveUserWhitespace`, deliberately: the two
/// clients must render the same paste the same way.
struct VerbatimContext {
    /// The original markdown, split by line, for restoring stripped indentation.
    let sourceLines: [String]

    /// The 1-based column where the containing block's CONTENT begins.
    ///
    /// Anchoring on this is what keeps a blockquote's `> ` marker and a list
    /// item's `- ` marker out of the restored text: only whitespace at or after
    /// the content column is eligible to be restored.
    let contentColumn: Int

    init(source: String, contentColumn: Int = 1) {
        self.sourceLines = source.components(separatedBy: "\n")
        self.contentColumn = contentColumn
    }

    private init(sourceLines: [String], contentColumn: Int) {
        self.sourceLines = sourceLines
        self.contentColumn = contentColumn
    }

    /// The same source, re-anchored to a nested container's content column.
    func nested(contentColumn: Int) -> VerbatimContext {
        VerbatimContext(sourceLines: sourceLines, contentColumn: contentColumn)
    }

    /// The whitespace the block parser stripped from the start of `line`.
    ///
    /// Returns "" when the line does not exist, carries no indentation beyond
    /// the content column, or when the candidate slice is not purely whitespace
    /// (which means the column math landed somewhere unexpected — an unusual
    /// container — and guessing would inject source characters into the text).
    func restoredIndent(forLine line: Int) -> String {
        guard line >= 1, line <= sourceLines.count else { return "" }
        let source = sourceLines[line - 1]
        let leading = source.prefix { $0 == " " || $0 == "\t" }
        guard leading.count > contentColumn - 1 else { return "" }
        let start = source.index(source.startIndex, offsetBy: contentColumn - 1)
        let end = source.index(source.startIndex, offsetBy: leading.count)
        return String(source[start..<end])
    }

    /// The verbatim source of an indented (non-fenced) code block, indentation
    /// intact, so it can be re-emitted as a plain paragraph instead of a card.
    func indentedCodeSource(_ codeBlock: Markdown.CodeBlock) -> String? {
        guard let range = codeBlock.range else { return nil }
        let first = range.lowerBound.line
        let last = range.upperBound.line
        guard first >= 1, first <= sourceLines.count else { return nil }
        let upper = min(last, sourceLines.count)
        guard upper >= first else { return nil }
        var lines = Array(sourceLines[(first - 1)..<upper])
        // Trailing blank lines belong to block separation, not the content.
        while let last = lines.last, last.trimmingCharacters(in: .whitespaces).isEmpty {
            lines.removeLast()
        }
        guard !lines.isEmpty else { return nil }
        return lines.joined(separator: "\n")
    }

    /// True when a code block came from an explicit fence rather than from
    /// indentation. A fenced block is intentional and stays a code card; an
    /// indented one in a paste is usually accidental alignment.
    func isFenced(_ codeBlock: Markdown.CodeBlock) -> Bool {
        // A language tag can only come from a fence's info string.
        if let language = codeBlock.language, !language.isEmpty { return true }
        guard let range = codeBlock.range else { return false }
        let line = range.lowerBound.line
        guard line >= 1, line <= sourceLines.count else { return false }
        let trimmed = sourceLines[line - 1].trimmingCharacters(in: .whitespaces)
        return trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~")
    }
}

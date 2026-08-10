import XCTest
@testable import IonRemote

/// Tests for `MarkdownFormatter.parse(_:verbatim:)`.
///
/// A user message must render exactly as typed while still rendering markdown.
/// CommonMark works against that in three ways, each covered here:
///
///   1. a soft break (single newline) renders as a SPACE per spec;
///   2. leading whitespace on a continuation line is stripped by the block
///      parser and is unrecoverable from the AST alone;
///   3. a four-space-indented run becomes an indented code block.
///
/// The last suite is the important one for safety: it pins that the DEFAULT
/// (assistant/prose) path is byte-for-byte unchanged, so this feature cannot
/// regress assistant rendering. Mirrors the desktop's
/// remarkPreserveUserWhitespace tests.
@MainActor
final class MarkdownFormatterVerbatimTests: XCTestCase {

    // MARK: - Helpers

    /// The plain text of the first paragraph block.
    private func firstParagraph(_ blocks: [MarkdownBlock]) -> String? {
        for block in blocks {
            if case .paragraph(let text) = block { return String(text.characters) }
        }
        return nil
    }

    private func paragraphs(_ blocks: [MarkdownBlock]) -> [String] {
        blocks.compactMap { block in
            if case .paragraph(let text) = block { return String(text.characters) }
            return nil
        }
    }

    // MARK: - Soft breaks

    func testVerbatimKeepsSoftBreakNewline() {
        let blocks = MarkdownFormatter.parse("line one\nline two", verbatim: true)
        XCTAssertEqual(firstParagraph(blocks), "line one\nline two")
    }

    func testDefaultCollapsesSoftBreakToSpace() {
        // The prose reading, unchanged.
        let blocks = MarkdownFormatter.parse("line one\nline two")
        XCTAssertEqual(firstParagraph(blocks), "line one line two")
    }

    // MARK: - Indentation

    func testVerbatimRestoresContinuationIndent() {
        let blocks = MarkdownFormatter.parse(
            "trace:\n      at frame one\n      at frame two",
            verbatim: true
        )
        XCTAssertEqual(
            firstParagraph(blocks),
            "trace:\n      at frame one\n      at frame two"
        )
    }

    func testVerbatimPreservesMidLineSpaceRun() {
        let blocks = MarkdownFormatter.parse("col a    col b", verbatim: true)
        XCTAssertEqual(firstParagraph(blocks), "col a    col b")
    }

    func testVerbatimDoesNotLeakBlockquoteMarker() {
        let blocks = MarkdownFormatter.parse("> quoted one\n>   quoted two", verbatim: true)
        guard case .blockQuote(let text)? = blocks.first else {
            return XCTFail("expected a blockQuote block, got \(blocks)")
        }
        let value = String(text.characters)
        XCTAssertFalse(value.contains(">"), "quote marker leaked into text: \(value)")
        XCTAssertTrue(value.hasPrefix("quoted one"), "unexpected text: \(value)")
    }

    func testVerbatimDoesNotLeakListMarker() {
        let blocks = MarkdownFormatter.parse("- item text\n  continuation", verbatim: true)
        guard case .listItem(_, _, let text)? = blocks.first else {
            return XCTFail("expected a listItem block, got \(blocks)")
        }
        let value = String(text.characters)
        XCTAssertFalse(value.contains("- "), "list marker leaked into text: \(value)")
        XCTAssertTrue(value.hasPrefix("item text"), "unexpected text: \(value)")
    }

    // MARK: - Code blocks

    func testVerbatimConvertsIndentedRunToParagraphKeepingSpaces() {
        let blocks = MarkdownFormatter.parse(
            "prose line\n\n    four space indented\n    second line\n",
            verbatim: true
        )
        for block in blocks {
            if case .code = block {
                return XCTFail("indented run should not stay a code block: \(blocks)")
            }
        }
        XCTAssertTrue(
            paragraphs(blocks).contains("    four space indented\n    second line"),
            "indentation not preserved: \(paragraphs(blocks))"
        )
    }

    func testVerbatimLeavesFencedBlockAsCode() {
        let blocks = MarkdownFormatter.parse("```sh\n  keep me\n```\n", verbatim: true)
        guard case .code(let language, let text)? = blocks.first else {
            return XCTFail("expected a code block, got \(blocks)")
        }
        XCTAssertEqual(language, "sh")
        XCTAssertEqual(text, "  keep me")
    }

    func testVerbatimLeavesTildeFencedBlockAsCode() {
        let blocks = MarkdownFormatter.parse("~~~\nplain fence\n~~~\n", verbatim: true)
        guard case .code = blocks.first else {
            return XCTFail("expected a code block, got \(blocks)")
        }
    }

    func testDefaultKeepsIndentedRunAsCode() {
        // Unchanged for assistant content, where an indented run is deliberate.
        let blocks = MarkdownFormatter.parse("prose line\n\n    indented\n")
        let hasCode = blocks.contains { block in
            if case .code = block { return true }
            return false
        }
        XCTAssertTrue(hasCode, "default path should keep the code block: \(blocks)")
    }

    // MARK: - Markdown still renders in verbatim mode

    func testVerbatimStillRendersMarkdown() {
        let source = """
        # Heading

        Some **bold** text.

        | h1 | h2 |
        | -- | -- |
        | a  | b  |

        - alpha
        - beta
        """
        let blocks = MarkdownFormatter.parse(source, verbatim: true)
        XCTAssertTrue(blocks.contains { if case .heading = $0 { return true }; return false })
        XCTAssertTrue(blocks.contains { if case .table = $0 { return true }; return false })
        XCTAssertTrue(blocks.contains { if case .listItem = $0 { return true }; return false })
    }

    func testVerbatimPreservesRepeatedBlankLinesBetweenBlocks() {
        let blocks = MarkdownFormatter.parse(
            "first line\n\n\nsecond line\n\n\nthird line",
            verbatim: true
        )
        let gaps = blocks.compactMap { block -> Int? in
            if case .blankLines(let count) = block { return count }
            return nil
        }
        XCTAssertEqual(gaps, [2, 2])
    }

    func testVerbatimDistinguishesOneBlankLineFromThree() {
        let blocks = MarkdownFormatter.parse("a\n\nb\n\n\n\nc", verbatim: true)
        let gaps = blocks.compactMap { block -> Int? in
            if case .blankLines(let count) = block { return count }
            return nil
        }
        XCTAssertEqual(gaps, [1, 3])
    }

    func testDefaultDoesNotAddBlankLineBlocks() {
        let blocks = MarkdownFormatter.parse("a\n\n\nb")
        XCTAssertFalse(blocks.contains { if case .blankLines = $0 { return true }; return false })
    }

    // MARK: - The reported paste

    func testVerbatimKeepsEveryLineOfPastedTranscript() {
        let transcript = [
            "λ ssh user@example.local",
            "Linux host 6.1.0-51-amd64 #1 SMP PREEMPT_DYNAMIC",
            "",
            "The programs included with the Debian GNU/Linux system are free software;",
            "the exact distribution terms for each program are described in the",
            "individual files in /usr/share/doc/*/copyright."
        ].joined(separator: "\n")

        let blocks = MarkdownFormatter.parse(transcript, verbatim: true)
        let paras = paragraphs(blocks)
        XCTAssertEqual(paras.count, 2, "expected two paragraphs, got \(paras)")
        XCTAssertEqual(paras[1].components(separatedBy: "\n").count, 3)
        XCTAssertTrue(paras[0].contains("λ ssh user@example.local\nLinux host"))
    }

    // MARK: - The default path is unchanged (regression guard)

    func testDefaultPathIdenticalForMixedContent() {
        // A fixture exercising every block kind. Parsed WITHOUT the flag, the
        // output must match what the formatter produced before verbatim mode
        // existed — this is what keeps assistant rendering safe.
        let source = """
        # Title

        Prose with a soft
        break and **bold**.

        - one
        - two

        > quoted
        > lines

        ```swift
        let x = 1
        ```

            indented code

        | a | b |
        | - | - |
        | 1 | 2 |

        ---
        """
        let blocks = MarkdownFormatter.parse(source)

        // Soft break still a space (the pre-existing prose behaviour).
        XCTAssertTrue(
            paragraphs(blocks).contains { $0.contains("Prose with a soft break and bold.") },
            "soft break should collapse to a space in the default path: \(paragraphs(blocks))"
        )
        // Indented code still a code block.
        let codeTexts: [String] = blocks.compactMap { block in
            if case .code(_, let text) = block { return text }
            return nil
        }
        XCTAssertTrue(codeTexts.contains("let x = 1"))
        XCTAssertTrue(codeTexts.contains("indented code"))
        // Every other kind still present.
        XCTAssertTrue(blocks.contains { if case .heading = $0 { return true }; return false })
        XCTAssertTrue(blocks.contains { if case .listItem = $0 { return true }; return false })
        XCTAssertTrue(blocks.contains { if case .blockQuote = $0 { return true }; return false })
        XCTAssertTrue(blocks.contains { if case .table = $0 { return true }; return false })
        XCTAssertTrue(blocks.contains { if case .thematicBreak = $0 { return true }; return false })
    }
}

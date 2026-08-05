import XCTest
@testable import IonRemote

/// Tests for `MarkdownFormatter.parse(_:)`. The primary goal is to lock in
/// the fix for the iOS truncation defect (conversation
/// `1780405865550-54fac261fb2e`, entry `f1c0d1b6`) where Foundation's
/// `AttributedString(markdown:)` silently dropped everything after the
/// second fenced code block. Beyond that, we exercise the robustness
/// contract: unclosed fences, malformed tables, mismatched delimiters,
/// mixed line endings, pathological size, and empty input. Every test
/// asserts `parse(...)` returns non-empty and does not throw.
@MainActor
final class MarkdownFormatterTests: XCTestCase {

    // MARK: - Regression: the truncation bug

    /// The original defect: the f1c0d1b6 corpus contains four fenced code
    /// blocks, multiple tables, ~20 headings, and ~12 KB of mixed content.
    /// Foundation returned the prefix through the second code block and
    /// dropped the rest. swift-markdown returns the entire document.
    func testLongMixedContentParsesInFull() {
        let blocks = MarkdownFormatter.parse(MarkdownFormatterFixtures.longMixedContent)

        // Lower bound: the real count is ~80. We assert ≥ 30 to catch any
        // future regression where a parser change silently halves output
        // without going all the way to zero.
        XCTAssertGreaterThanOrEqual(
            blocks.count, 30,
            "expected ≥30 blocks for 12KB mixed-content corpus, got \(blocks.count)"
        )

        // The closing line. If this is missing, the parser dropped the tail.
        let allText = plainText(of: blocks)
        XCTAssertTrue(
            allText.contains("STOP"),
            "tail content missing: closing 'STOP — awaiting confirmation' not in output"
        )
        XCTAssertTrue(
            allText.contains("awaiting confirmation"),
            "tail content missing: 'awaiting confirmation' phrase not in output"
        )

        // At least 3 fenced code blocks should land as `.code(...)`. The
        // corpus contains 4; ≥ 3 leaves headroom if a future parser change
        // merges an adjacent fence into surrounding text.
        let codeCount = blocks.filter {
            if case .code = $0 { return true } else { return false }
        }.count
        XCTAssertGreaterThanOrEqual(
            codeCount, 3,
            "expected ≥3 code blocks, got \(codeCount)"
        )
    }

    // MARK: - Robustness: malformed / partial markdown

    /// LLM cut off mid-stream: opens a fenced code block with ``` and never
    /// closes it. Per the CommonMark spec, the code block extends to EOF.
    /// We assert the trailing content lands as a `.code(...)` block and no
    /// content is lost.
    func testUnclosedFenceFromCutOffStream() {
        let input = """
        Here is some prose before the cut-off.

        ```swift
        func foo() {
            let x = 1
        // (LLM cut off here, no closing fence)
        """

        let blocks = MarkdownFormatter.parse(input)

        XCTAssertFalse(blocks.isEmpty, "must return ≥1 block for non-empty input")

        // The fenced code block must be present (per CommonMark, EOF closes it).
        let codeBlocks = blocks.compactMap { block -> String? in
            if case .code(_, let code) = block { return code } else { return nil }
        }
        XCTAssertGreaterThanOrEqual(
            codeBlocks.count, 1,
            "unclosed fence should still produce a code block at EOF"
        )

        // The body text from the cut-off body should be present somewhere
        // in the parse output (either inside the code block or as paragraph
        // text, depending on how the parser ended the block).
        let allText = plainText(of: blocks)
        XCTAssertTrue(
            allText.contains("func foo()"),
            "cut-off code content was lost: 'func foo()' missing from parse"
        )
    }

    /// A header-only "table" with no separator row. Per GFM, this is not a
    /// table — it should fall through to paragraph text. The pipe-delimited
    /// text must still appear in the output.
    func testUnclosedTableDemotedToParagraph() {
        let input = """
        | a | b | c |
        Some text after the fake header row.
        """

        let blocks = MarkdownFormatter.parse(input)

        XCTAssertFalse(blocks.isEmpty)
        // No table block should be present.
        let tableCount = blocks.filter {
            if case .table = $0 { return true } else { return false }
        }.count
        XCTAssertEqual(tableCount, 0, "malformed table must not produce a .table block")

        // The pipe text and the trailing prose must both survive.
        let allText = plainText(of: blocks)
        XCTAssertTrue(allText.contains("a"))
        XCTAssertTrue(allText.contains("Some text after"))
    }

    /// Open with ``` but "close" with ~~~. CommonMark requires the closer
    /// match the opener exactly, so ~~~ is body text and the fence runs to
    /// EOF. No throw, all content preserved.
    func testMismatchedFenceDelimiters() {
        let input = """
        ```swift
        let x = 1
        ~~~
        let y = 2
        """

        let blocks = MarkdownFormatter.parse(input)

        XCTAssertFalse(blocks.isEmpty)
        let allText = plainText(of: blocks)
        XCTAssertTrue(allText.contains("let x = 1"))
        XCTAssertTrue(allText.contains("let y = 2"))
        XCTAssertTrue(allText.contains("~~~"),
                     "mismatched closer should be body text, not a separator")
    }

    /// Feed progressive prefixes of a multi-block document, simulating
    /// engine_text_delta arrival mid-stream. Every prefix must parse
    /// without throwing and return ≥ 1 block.
    func testPartialStreamingInput() {
        let full = """
        # Heading

        Some prose.

        ```swift
        let x = 1
        ```

        - bullet one
        - bullet two
        """

        // Sample at byte offsets 1, 4, 16, 64, 256, ..., and the full length.
        var offsets: [Int] = []
        var n = 1
        while n < full.count {
            offsets.append(n)
            n *= 4
        }
        offsets.append(full.count)

        for offset in offsets {
            let prefix = String(full.prefix(offset))
            let blocks = MarkdownFormatter.parse(prefix)
            XCTAssertGreaterThanOrEqual(
                blocks.count, 1,
                "prefix len=\(offset) returned 0 blocks"
            )
        }
    }

    /// CRLF, LF, and CR variants of the same document must produce the same
    /// block count. swift-markdown normalizes per CommonMark; we also
    /// normalize on entry as belt-and-suspenders.
    func testMixedLineEndings() {
        let lf = "# Heading\n\nSome prose.\n\n- bullet\n"
        let crlf = lf.replacingOccurrences(of: "\n", with: "\r\n")
        let cr = lf.replacingOccurrences(of: "\n", with: "\r")

        let lfBlocks = MarkdownFormatter.parse(lf)
        let crlfBlocks = MarkdownFormatter.parse(crlf)
        let crBlocks = MarkdownFormatter.parse(cr)

        XCTAssertEqual(lfBlocks.count, crlfBlocks.count,
                      "CRLF and LF should produce same block count")
        XCTAssertEqual(lfBlocks.count, crBlocks.count,
                      "CR and LF should produce same block count")
    }

    /// 5MB single paragraph: must parse in bounded time and produce a small
    /// number of paragraph blocks (cmark-gfm is a streaming C parser).
    func testPathologicalSize() {
        // Single very long line (no newlines) → one paragraph.
        let big = String(repeating: "a ", count: 2_500_000)
        XCTAssertGreaterThan(big.count, 4_000_000)

        let start = Date()
        let blocks = MarkdownFormatter.parse(big)
        let elapsed = Date().timeIntervalSince(start)

        XCTAssertFalse(blocks.isEmpty)
        // Generous bound — we just want to catch O(n²) regressions.
        XCTAssertLessThan(elapsed, 10.0,
                         "5MB parse took \(elapsed)s; expected < 10s")
    }

    /// "Table-like" prose with pipes but no separator: must demote to
    /// paragraph(s), never crash, and preserve all pipe text.
    func testAdversarialTableLikeProse() {
        let input = """
        Here is some text | with pipes | scattered around |
        | More | pipes | in the next line |
        Final line.
        """

        let blocks = MarkdownFormatter.parse(input)
        XCTAssertFalse(blocks.isEmpty)
        let tableCount = blocks.filter {
            if case .table = $0 { return true } else { return false }
        }.count
        XCTAssertEqual(tableCount, 0)

        let allText = plainText(of: blocks)
        XCTAssertTrue(allText.contains("Final line"))
    }

    /// Empty string and whitespace-only input both produce a single empty
    /// paragraph (the no-blocks-ever-returned invariant).
    func testEmptyInput() {
        let empty = MarkdownFormatter.parse("")
        XCTAssertEqual(empty.count, 1, "empty input should return [.paragraph(empty)]")
        if case .paragraph(let t) = empty[0] {
            XCTAssertEqual(String(t.characters), "")
        } else {
            XCTFail("expected single .paragraph for empty input, got \(empty)")
        }

        let whitespace = MarkdownFormatter.parse("   \n\n  \t  \n")
        XCTAssertEqual(whitespace.count, 1, "whitespace input should return one block")
    }

    // MARK: - Inline code chips + file-path links

    func testInlineCodeCarriesBackgroundChip() {
        let blocks = MarkdownFormatter.parse("some `hello` inline")
        guard case .paragraph(let text) = blocks[0] else {
            return XCTFail("expected paragraph, got \(blocks)")
        }
        let codeRun = text.runs.first { run in
            String(text[run.range].characters) == "hello"
        }
        XCTAssertNotNil(codeRun, "the inline code run must exist")
        XCTAssertNotNil(codeRun?.backgroundColor, "inline code must render as a background chip")
        XCTAssertNil(codeRun?.link, "prose inline code must not carry a link")
    }

    func testInlineCodeFilePathCarriesIonFileLink() {
        let blocks = MarkdownFormatter.parse("see `src/foo.ts:12` for details")
        guard case .paragraph(let text) = blocks[0] else {
            return XCTFail("expected paragraph, got \(blocks)")
        }
        let pathRun = text.runs.first { run in
            String(text[run.range].characters) == "src/foo.ts:12"
        }
        XCTAssertNotNil(pathRun, "the file-path run must exist")
        let link = pathRun?.link
        XCTAssertEqual(link?.scheme, "ion-file", "detected file paths must link via ion-file://")
        XCTAssertEqual(link.flatMap(FilePathDetector.path(from:)), "src/foo.ts")
        XCTAssertNotNil(pathRun?.backgroundColor, "file-path chips keep the code chip background")
    }

    // MARK: - Helpers

    /// Plain-text concatenation of every block's text for substring assertions.
    private func plainText(of blocks: [MarkdownBlock]) -> String {
        var out = ""
        for block in blocks {
            switch block {
            case .heading(_, let t):     out += String(t.characters) + "\n"
            case .paragraph(let t):      out += String(t.characters) + "\n"
            case .code(_, let text):     out += text + "\n"
            case .blockQuote(let t):     out += String(t.characters) + "\n"
            case .listItem(_, _, let t): out += String(t.characters) + "\n"
            case .thematicBreak:         out += "---\n"
            case .table(let headers, let rows, _):
                out += headers.map { String($0.characters) }.joined(separator: " | ") + "\n"
                for row in rows {
                    out += row.map { String($0.characters) }.joined(separator: " | ") + "\n"
                }
            }
        }
        return out
    }
}

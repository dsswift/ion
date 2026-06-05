import XCTest
@testable import IonRemote

/// Tests for `FrontmatterSplitter.split(_:)`. Pins the contract documented
/// on the type so future refactors cannot silently regress the parity
/// behavior shared with the desktop renderer's `splitFrontmatter` helper.
///
/// The behavioral baseline is the same shape as the desktop tests
/// implicitly cover via the `FileEditorPreview` snapshot: first-line `---`
/// gate, closing-fence scan, unclosed-fence ⇒ no frontmatter, and
/// leading-whitespace trim on the returned body.
final class FrontmatterSplitterTests: XCTestCase {

    // MARK: - No frontmatter

    func testNoFrontmatterWhenFirstLineIsNotFence() {
        let input = "# Heading\n\nBody text"
        let result = FrontmatterSplitter.split(input)
        XCTAssertNil(result.frontmatterRaw)
        XCTAssertEqual(result.body, input)
    }

    func testNoFrontmatterOnEmptyInput() {
        let result = FrontmatterSplitter.split("")
        XCTAssertNil(result.frontmatterRaw)
        XCTAssertEqual(result.body, "")
    }

    func testNoFrontmatterWhenFirstLineHasContentAfterFence() {
        // A line like `---note` is not a fence; it must trim to exactly `---`.
        let input = "---note\nkey: value\n---\nbody"
        let result = FrontmatterSplitter.split(input)
        XCTAssertNil(result.frontmatterRaw)
        XCTAssertEqual(result.body, input)
    }

    // MARK: - Frontmatter happy path

    func testSplitsFrontmatterFromBody() {
        let input = """
        ---
        description: hello
        model: smart
        ---
        # Real Heading

        Body paragraph.
        """
        let result = FrontmatterSplitter.split(input)
        XCTAssertEqual(result.frontmatterRaw, "description: hello\nmodel: smart")
        XCTAssertEqual(result.body, "# Real Heading\n\nBody paragraph.")
    }

    func testFrontmatterWithEmptyBlockIsRecognized() {
        let input = "---\n---\n# Heading"
        let result = FrontmatterSplitter.split(input)
        XCTAssertEqual(result.frontmatterRaw, "")
        XCTAssertEqual(result.body, "# Heading")
    }

    func testFrontmatterWithEmptyBody() {
        let input = "---\nkey: value\n---\n"
        let result = FrontmatterSplitter.split(input)
        XCTAssertEqual(result.frontmatterRaw, "key: value")
        XCTAssertEqual(result.body, "")
    }

    func testFenceWithTrailingWhitespaceIsRecognized() {
        // The fence lines must be exactly `---` after trimming
        // `.whitespacesAndNewlines`. Stray spaces/tabs/CR are absorbed.
        let input = "---   \nkey: value\n---\t\nbody"
        let result = FrontmatterSplitter.split(input)
        XCTAssertEqual(result.frontmatterRaw, "key: value")
        XCTAssertEqual(result.body, "body")
    }

    func testCRLFLineEndingsHandled() {
        // CRLF input: the splitter should still recognize the fences
        // because the trailing `\r` lands inside the
        // `.whitespacesAndNewlines` trim set.
        let input = "---\r\nkey: value\r\n---\r\n# Heading"
        let result = FrontmatterSplitter.split(input)
        XCTAssertEqual(result.frontmatterRaw, "key: value\r")
        // The `\r` survives because we only split on `\n` and don't
        // pre-normalize. The downstream markdown parser normalizes line
        // endings itself; this test pins the raw splitter behavior.
        XCTAssertEqual(result.body, "# Heading")
    }

    // MARK: - Unclosed fence degrades safely

    func testUnclosedFenceDegradesToNoFrontmatter() {
        // The user typed `---` somewhere near the top but never closed
        // it. We must not swallow the entire document — that would be a
        // surprising failure mode where the markdown preview vanishes.
        let input = "---\nkey: value\nbut no closing fence\n# Heading\nBody"
        let result = FrontmatterSplitter.split(input)
        XCTAssertNil(result.frontmatterRaw)
        XCTAssertEqual(result.body, input)
    }

    // MARK: - Body trim

    func testBodyHasLeadingWhitespaceTrimmed() {
        // The desktop renderer uses `String.prototype.trimStart` on the
        // body so the markdown parser doesn't start with a phantom
        // blank line that would push the first heading down. The Swift
        // splitter must match.
        let input = "---\nkey: value\n---\n\n\n   # Heading"
        let result = FrontmatterSplitter.split(input)
        XCTAssertEqual(result.frontmatterRaw, "key: value")
        XCTAssertEqual(result.body, "# Heading")
    }

    // MARK: - Regression: the underlying bug

    /// Pinning the actual user-visible bug. Without splitting, swift-markdown
    /// sees `description: hello\n---` as a setext H2 ("description: hello"
    /// underlined by `---`), and the real `# Frontmatter Test` heading is
    /// degraded. After splitting, the body the parser sees starts with the
    /// real H1 heading, so the regression cannot recur.
    func testRegressionFirstHeadingPreservedBelowFrontmatter() {
        let input = """
        ---
        description: hello
        ---
        # Frontmatter Test

        Some body.
        """
        let result = FrontmatterSplitter.split(input)
        XCTAssertNotNil(result.frontmatterRaw)
        XCTAssertTrue(
            result.body.hasPrefix("# Frontmatter Test"),
            "body must start with the real H1 heading; got: \(result.body.prefix(40))"
        )
    }
}

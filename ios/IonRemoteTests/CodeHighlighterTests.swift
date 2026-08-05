import SwiftUI
import XCTest
@testable import IonRemote

@MainActor
final class CodeHighlighterTests: XCTestCase {
    func testHighlightProducesMultipleColorRuns() {
        let code = """
        func greet(name: String) -> String {
            // say hello
            return "Hello! Count: 42"
        }
        """
        let result = CodeHighlighter.shared.highlight(
            code: code, language: "swift", theme: IonDarkTheme()
        )
        var colors = Set<String>()
        for run in result.runs {
            if let color = run.foregroundColor {
                colors.insert(IonCodeTheme.hex(color))
            }
        }
        XCTAssertGreaterThanOrEqual(
            colors.count, 2,
            "highlighting must produce at least two distinct foreground colors, got \(colors)"
        )
    }

    func testKeywordColorDerivesFromThemePalette() {
        let theme = IonDarkTheme()
        let result = CodeHighlighter.shared.highlight(
            code: "let x = 1", language: "swift", theme: theme
        )
        let expected = IonCodeTheme.hex(theme.codeKeyword)
        var found = false
        for run in result.runs {
            guard let color = run.foregroundColor else { continue }
            if IonCodeTheme.hex(color) == expected {
                found = true
                break
            }
        }
        XCTAssertTrue(found, "the `let` keyword must carry ion-dark codeKeyword (\(expected))")
    }

    func testHighlightPreservesSourceTextExactly() {
        let code = "func f() -> Int { return 1 < 2 ? 1 : 0 } // \"quoted\" & <angled>"
        let result = CodeHighlighter.shared.highlight(
            code: code, language: "swift", theme: IonDarkTheme()
        )
        XCTAssertEqual(String(result.characters), code, "entity decode must round-trip the source")
    }

    func testCachedResultIsStablePerThemeAndCode() {
        let theme = IonDarkTheme()
        let code = "let cached = true"
        let first = CodeHighlighter.shared.highlight(code: code, language: "swift", theme: theme)
        let second = CodeHighlighter.shared.highlight(code: code, language: "swift", theme: theme)
        XCTAssertEqual(first, second)
    }

    func testUnknownLanguageFallsBackWithoutThrowing() {
        let result = CodeHighlighter.shared.highlight(
            code: "plain text body", language: "not-a-language-id", theme: IonDarkTheme()
        )
        XCTAssertEqual(String(result.characters), "plain text body")
    }

    func testNilLanguageReturnsPlainString() {
        let result = CodeHighlighter.shared.highlight(
            code: "no language", language: nil, theme: IonDarkTheme()
        )
        XCTAssertEqual(String(result.characters), "no language")
        XCTAssertNil(result.runs.first { $0.foregroundColor != nil })
    }

    // MARK: - IonCodeTheme class mapping

    func testEveryCodeTokenIsReachableFromAnHljsClass() {
        let theme = IonDarkTheme()
        let expectations: [(classes: [String], token: Color)] = [
            (["hljs-keyword"], theme.codeKeyword),
            (["hljs-string"], theme.codeString),
            (["hljs-number"], theme.codeNumber),
            (["hljs-comment"], theme.codeComment),
            (["hljs-title", "function_"], theme.codeFunction),
            (["hljs-title", "class_"], theme.codeType),
            (["hljs-variable"], theme.codeVariable),
            (["hljs-operator"], theme.codeOperator),
        ]
        for (classes, token) in expectations {
            let resolved = IonCodeTheme.color(forClasses: classes, theme: theme)
            XCTAssertEqual(
                resolved.map(IonCodeTheme.hex), IonCodeTheme.hex(token),
                "classes \(classes) must map to their token"
            )
        }
    }

    func testUnknownClassesInheritSurroundingColor() {
        XCTAssertNil(IonCodeTheme.color(forClasses: ["hljs-unknown-thing"], theme: IonDarkTheme()))
    }

    // MARK: - Span parser

    func testSpanParserHandlesNestedSpansAndEntities() {
        let theme = IonDarkTheme()
        let html = "<span class=\"hljs-keyword\">let</span> x &lt;- <span class=\"hljs-string\">&quot;a&amp;b&quot;</span>"
        let parsed = HljsSpanParser.parse(html, theme: theme)
        XCTAssertEqual(String(parsed.characters), "let x <- \"a&b\"")
        let keywordRun = parsed.runs.first { String(parsed[$0.range].characters) == "let" }
        XCTAssertEqual(
            keywordRun?.foregroundColor.map(IonCodeTheme.hex),
            IonCodeTheme.hex(theme.codeKeyword)
        )
    }
}

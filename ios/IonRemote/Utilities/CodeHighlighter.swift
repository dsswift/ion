import Foundation
import JavaScriptCore
import SwiftUI

// MARK: - CodeHighlighter

/// highlight.js (bundled `highlight.min.js`, run in a JSContext) wrapper
/// producing themed `AttributedString`s for conversation code blocks.
///
/// The Highlightr package wraps the same engine but keeps its custom-theme
/// initializer internal (only bundled CSS themes are reachable), so Ion runs
/// hljs directly and maps the emitted `hljs-*` token classes onto the active
/// `AppTheme`'s code-syntax tokens via `IonCodeTheme` — colors derive from the
/// theme with no CSS round-trip, and synced theme packs recolor for free.
///
/// - Results are cached (NSCache, ~300 entries) keyed on theme id + language
///   + code hash, so a transcript re-render never re-highlights an unchanged
///   block. The cache is never cleared on theme switch — the theme id
///   partitions the keys, and NSCache evicts under pressure.
/// - Only foreground colors are applied, so the SwiftUI `.font` modifier
///   owns the typeface and Dynamic Type sizing.
/// - Never throws: any failure (missing resource, JS error, unknown
///   language) logs and yields the plain string (no silent failures).
@MainActor
final class CodeHighlighter {
    static let shared = CodeHighlighter()

    private let hljs: JSValue?
    private let cache = NSCache<NSString, CachedHighlight>()

    /// NSCache requires a class; wraps the value-typed AttributedString.
    private final class CachedHighlight {
        let value: AttributedString
        init(_ value: AttributedString) { self.value = value }
    }

    private init() {
        cache.countLimit = 300
        guard let path = Bundle.main.path(forResource: "highlight.min", ofType: "js"),
              let context = JSContext() else {
            hljs = nil
            DiagnosticLog.log(
                "highlight.js failed to load; code blocks render plain",
                tag: "code-highlight", level: .warn
            )
            return
        }
        let source: String
        do {
            source = try String(contentsOfFile: path, encoding: .utf8)
        } catch {
            hljs = nil
            DiagnosticLog.log(
                "highlight.min.js unreadable; code blocks render plain",
                tag: "code-highlight", level: .warn, fields: [
                    "reason": String(describing: error)
                ]
            )
            return
        }
        context.evaluateScript(source)
        hljs = context.objectForKeyedSubscript("hljs")
        if hljs == nil || hljs!.isUndefined {
            DiagnosticLog.log(
                "hljs global missing after evaluate; code blocks render plain",
                tag: "code-highlight", level: .warn
            )
        } else {
            DiagnosticLog.log("code highlighter initialized", tag: "code-highlight")
        }
    }

    /// Highlight `code` as `language` under `theme`. Unknown/absent languages
    /// and any JS failure fall back to the un-colored string.
    func highlight(code: String, language: String?, theme: any AppTheme) -> AttributedString {
        guard let hljs, !hljs.isUndefined, let language, !language.isEmpty else {
            return AttributedString(code)
        }
        let key = "\(theme.id)\u{1}\(language)\u{1}\(code.hashValue)" as NSString
        if let hit = cache.object(forKey: key) {
            return hit.value
        }
        guard let html = highlightHTML(code: code, language: language, hljs: hljs) else {
            return AttributedString(code)
        }
        let attributed = HljsSpanParser.parse(html, theme: theme)
        cache.setObject(CachedHighlight(attributed), forKey: key)
        return attributed
    }

    /// Run hljs.highlight; on an unregistered language id, retry with auto
    /// detection before giving up.
    private func highlightHTML(code: String, language: String, hljs: JSValue) -> String? {
        let options: [String: Any] = ["language": language, "ignoreIllegals": true]
        if let result = hljs.invokeMethod("highlight", withArguments: [code, options]),
           !result.isUndefined,
           let value = result.objectForKeyedSubscript("value"), value.isString {
            return value.toString()
        }
        if let auto = hljs.invokeMethod("highlightAuto", withArguments: [code]),
           !auto.isUndefined,
           let value = auto.objectForKeyedSubscript("value"), value.isString {
            return value.toString()
        }
        DiagnosticLog.log("highlight failed for language", tag: "code-highlight", fields: [
            "language": language
        ])
        return nil
    }
}

// MARK: - HljsSpanParser

/// Parses highlight.js span-markup output
/// (`<span class="hljs-keyword">let</span>`, possibly nested, with HTML
/// entities) into an AttributedString, resolving each class stack through
/// `IonCodeTheme`. Internal (not private) for unit testing.
enum HljsSpanParser {
    static func parse(_ html: String, theme: any AppTheme) -> AttributedString {
        var result = AttributedString()
        // Stack of open span class-lists (a token may nest, e.g. title inside function).
        var stack: [[String]] = []
        var index = html.startIndex

        func appendText(_ text: String) {
            guard !text.isEmpty else { return }
            var run = AttributedString(decodeEntities(text))
            // Innermost span wins; walk outward until a class maps.
            for classes in stack.reversed() {
                if let color = IonCodeTheme.color(forClasses: classes, theme: theme) {
                    run.foregroundColor = color
                    break
                }
            }
            result.append(run)
        }

        var textStart = index
        while index < html.endIndex {
            guard html[index] == "<" else {
                index = html.index(after: index)
                continue
            }
            appendText(String(html[textStart..<index]))
            if html[index...].hasPrefix("</span>") {
                if !stack.isEmpty { stack.removeLast() }
                index = html.index(index, offsetBy: 7)
            } else if html[index...].hasPrefix("<span"),
                      let close = html[index...].firstIndex(of: ">") {
                let tag = String(html[index...close])
                stack.append(classList(fromSpanTag: tag))
                index = html.index(after: close)
            } else {
                // A literal '<' from the source code (hljs escapes these as
                // &lt;, so a bare one is defensive) — emit it as text.
                appendText("<")
                index = html.index(after: index)
            }
            textStart = index
        }
        appendText(String(html[textStart...]))
        return result
    }

    /// `<span class="hljs-title function_">` → ["hljs-title", "function_"]
    private static func classList(fromSpanTag tag: String) -> [String] {
        guard let attrRange = tag.range(of: "class=\""),
              let end = tag[attrRange.upperBound...].firstIndex(of: "\"") else {
            return []
        }
        return tag[attrRange.upperBound..<end].split(separator: " ").map(String.init)
    }

    /// The entity set hljs emits (it escapes &, <, >, ", ').
    private static func decodeEntities(_ text: String) -> String {
        guard text.contains("&") else { return text }
        var out = text
        out = out.replacingOccurrences(of: "&lt;", with: "<")
        out = out.replacingOccurrences(of: "&gt;", with: ">")
        out = out.replacingOccurrences(of: "&quot;", with: "\"")
        out = out.replacingOccurrences(of: "&#x27;", with: "'")
        out = out.replacingOccurrences(of: "&#39;", with: "'")
        out = out.replacingOccurrences(of: "&amp;", with: "&")
        return out
    }
}

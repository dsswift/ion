import SwiftUI

// MARK: - Links in prose
//
// The desktop turns a bare file path or web address in prose into a link
// (`LINK_RE` in desktop/src/renderer/hooks/link-segments.ts). This is the same
// detection, so a path the agent writes in a sentence is a link on the phone
// too, not only one inside `inline code`.
extension MarkdownFormatter {
    /// Web addresses, `~/` paths, absolute paths, and relative paths that end in an extension.
    private static let proseLinkPattern =
        #"(https?://[^\s<>"')\]]+|~/(?:[a-zA-Z0-9._~-]+/)*[a-zA-Z0-9._~-]+|/(?:[a-zA-Z0-9._~-]+/)+[a-zA-Z0-9._~-]+|[a-zA-Z0-9._~-]+(?:/[a-zA-Z0-9._~-]+)+\.[a-zA-Z0-9]+)"#
    // Pattern is a compile-time constant; an invalid literal is a programmer
    // error caught by MarkdownProseLinkTests before it could ship.
    // swiftlint:disable:next force_try
    private static let proseLinkRegex = try! NSRegularExpression(pattern: proseLinkPattern)

    /// `text` with every detected path and web address made a link.
    static func renderProseText(_ text: String) -> AttributedString {
        let ns = text as NSString
        var result = AttributedString()
        var cursor = 0
        for match in proseLinkRegex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            let raw = ns.substring(with: match.range)
            // Trailing punctuation belongs to the sentence, not the path.
            let trimmed = raw.replacingOccurrences(of: #"[.,;:!?)]+$"#, with: "", options: .regularExpression)
            guard !trimmed.isEmpty, let url = linkURL(for: trimmed) else { continue }
            if match.range.location > cursor {
                result.append(AttributedString(ns.substring(with: NSRange(location: cursor, length: match.range.location - cursor))))
            }
            var link = AttributedString(trimmed)
            link.link = url
            result.append(link)
            cursor = match.range.location + (trimmed as NSString).length
        }
        if cursor < ns.length {
            result.append(AttributedString(ns.substring(from: cursor)))
        }
        return result
    }

    private static func linkURL(for text: String) -> URL? {
        if text.hasPrefix("http://") || text.hasPrefix("https://") { return URL(string: text) }
        return FilePathDetector.url(for: FilePathRef(path: text, line: nil, column: nil))
    }
}

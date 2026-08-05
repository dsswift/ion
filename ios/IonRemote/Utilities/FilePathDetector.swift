import Foundation

// MARK: - FilePathDetector

/// A detected file-path reference inside inline text.
struct FilePathRef: Equatable {
    let path: String
    let line: Int?
    let column: Int?
}

/// Detects file-path-shaped strings in inline code spans so the markdown
/// renderer can turn them into tappable `ion-file://` links with a file-type
/// icon (parity with the desktop's file-path chips).
///
/// Deliberately conservative: a candidate must either contain a `/` between
/// plausible path components, or be a bare `name.ext` with a known code/text
/// extension. URLs and prose are rejected.
enum FilePathDetector {
    /// Extensions accepted for the bare `name.ext` form (no slash). The
    /// slashed form accepts any extension — the slash is signal enough.
    private static let knownExtensions: Set<String> = [
        "swift", "ts", "tsx", "js", "jsx", "mjs", "go", "rs", "py", "rb",
        "java", "kt", "c", "cpp", "h", "hpp", "cs", "json", "yaml", "yml",
        "toml", "md", "html", "css", "scss", "sql", "sh", "bash", "zsh",
        "lua", "php", "pl", "r", "dart", "txt", "xml", "plist", "proto",
    ]

    /// Path with optional `:line[:col]` suffix. Component charset mirrors the
    /// desktop's LINK_RE (letters, digits, dot, underscore, tilde, dash).
    private static let pathPattern = #"^(~?/?(?:[A-Za-z0-9._~-]+/)*[A-Za-z0-9._~-]+\.[A-Za-z0-9]+)(?::(\d+)(?::(\d+))?)?$"#
    // Pattern is a compile-time constant; an invalid literal is a programmer
    // error caught by FilePathDetectorTests before it could ship.
    // swiftlint:disable:next force_try
    private static let regex = try! NSRegularExpression(pattern: pathPattern)

    /// Returns the parsed reference when `text` is a file path, else nil.
    static func detect(_ text: String) -> FilePathRef? {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, trimmed.count <= 512 else { return nil }
        // URLs are links, not files.
        guard !trimmed.lowercased().hasPrefix("http://"),
              !trimmed.lowercased().hasPrefix("https://") else { return nil }
        // No whitespace inside a path.
        guard trimmed.rangeOfCharacter(from: .whitespacesAndNewlines) == nil else { return nil }

        let range = NSRange(trimmed.startIndex..., in: trimmed)
        guard let match = regex.firstMatch(in: trimmed, range: range),
              let pathRange = Range(match.range(at: 1), in: trimmed) else { return nil }
        let path = String(trimmed[pathRange])

        // Bare filename (no slash) must carry a known extension to avoid
        // turning prose like `package.json.bak` or `e.g.` into chips.
        if !path.contains("/") {
            let ext = (path as NSString).pathExtension.lowercased()
            guard knownExtensions.contains(ext) else { return nil }
        }

        var line: Int?
        var column: Int?
        if let lineRange = Range(match.range(at: 2), in: trimmed) {
            line = Int(trimmed[lineRange])
        }
        if let colRange = Range(match.range(at: 3), in: trimmed) {
            column = Int(trimmed[colRange])
        }
        return FilePathRef(path: path, line: line, column: column)
    }

    /// Encode a detected reference as the internal `ion-file://` URL the
    /// markdown views intercept via OpenURLAction. A URL path always carries
    /// a leading slash, so relative paths are tagged `rel=1` and the slash is
    /// stripped again on decode.
    static func url(for ref: FilePathRef) -> URL? {
        var components = URLComponents()
        components.scheme = "ion-file"
        components.host = ""
        let isAbsolute = ref.path.hasPrefix("/")
        components.path = isAbsolute ? ref.path : "/" + ref.path
        var query: [URLQueryItem] = []
        if !isAbsolute { query.append(URLQueryItem(name: "rel", value: "1")) }
        if let line = ref.line { query.append(URLQueryItem(name: "line", value: String(line))) }
        if let col = ref.column { query.append(URLQueryItem(name: "col", value: String(col))) }
        if !query.isEmpty { components.queryItems = query }
        return components.url
    }

    /// Decode an `ion-file://` URL back to the path (inverse of `url(for:)`).
    /// Returns nil for any other scheme.
    static func path(from url: URL) -> String? {
        guard url.scheme == "ion-file" else { return nil }
        let raw = url.path
        guard !raw.isEmpty else { return nil }
        let isRelative = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.contains { $0.name == "rel" && $0.value == "1" } ?? false
        return isRelative ? String(raw.dropFirst()) : raw
    }
}

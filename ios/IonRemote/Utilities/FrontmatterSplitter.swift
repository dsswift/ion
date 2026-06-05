import Foundation

/// Splits a markdown document into its YAML frontmatter block and body.
///
/// Mirrors the desktop renderer's `splitFrontmatter` helper in
/// `desktop/src/renderer/components/FileEditorPreview.tsx` so the two
/// reference clients render frontmatter-bearing markdown identically. The
/// motivation is the same on both platforms:
///
/// - CommonMark (and its GFM extension) does not understand YAML
///   frontmatter. The opening `---` is treated as plain text; the *closing*
///   `---`, sitting on its own line directly under a non-blank line, is
///   then matched as a **setext H2 underline**. The result is that the
///   first frontmatter key renders as a giant heading, the closing fence
///   is consumed as an `<hr>`, and parser state is corrupted enough that
///   the first real heading below the frontmatter renders as body text.
///   Splitting the frontmatter off before parsing avoids the misparse.
///
/// - The frontmatter is intentionally authored metadata (model hints,
///   descriptions, allowed bash lists for slash commands, etc.) and the
///   user should still be able to see it. The preview surfaces it in a
///   dedicated collapsible section above the markdown body rather than
///   discarding it.
///
/// Contract (pinned by `FrontmatterSplitterTests`):
///
/// - The first line of the input must be exactly `---` (trimmed) for any
///   frontmatter to be recognized. Anything else ⇒ no frontmatter, body
///   is the original content unchanged.
/// - Scanning starts from line 2 and looks for the next line that, when
///   trimmed, equals `---`. That line is the closing fence.
/// - If no closing fence is found, the helper degrades to "no frontmatter"
///   rather than swallowing the entire document. This avoids the
///   surprising failure mode where a user typed a single `---` somewhere
///   near the top of the file and the rest of the document vanishes
///   behind a collapsible section.
/// - The returned `frontmatterRaw` excludes the fence lines themselves so
///   the UI can show the YAML body verbatim (no double-`---` decoration).
/// - The returned `body` has leading whitespace/newlines trimmed so the
///   parsed markdown does not start with a phantom blank line.
///
/// We intentionally do *not* parse the YAML here. The goal is to show the
/// user exactly what is in the file, not a re-serialized projection of
/// it, and parsing would require a YAML dependency on iOS that is not
/// otherwise present in this client.
enum FrontmatterSplitter {

    /// Result of splitting a markdown document.
    struct Split {
        /// Raw frontmatter text (without the `---` fence lines). `nil`
        /// when the input has no recognized frontmatter block.
        let frontmatterRaw: String?

        /// Markdown body. When `frontmatterRaw` is `nil` this is the
        /// original input unchanged; otherwise it is the content below
        /// the closing fence with leading whitespace trimmed.
        let body: String
    }

    /// Split `content` into frontmatter and body. See the type-level doc
    /// for the contract.
    static func split(_ content: String) -> Split {
        // Split on `\n`. We do not pre-normalize CRLF here because the
        // markdown parser (swift-markdown) handles line-ending variants
        // itself; the only thing the splitter cares about is whether the
        // first line and some later line, after trimming, equal `---`.
        // Trimming with `.whitespacesAndNewlines` absorbs a stray `\r`
        // on Windows-style line endings.
        let lines = content.components(separatedBy: "\n")
        guard let first = lines.first,
              first.trimmingCharacters(in: .whitespacesAndNewlines) == "---"
        else {
            return Split(frontmatterRaw: nil, body: content)
        }

        // Scan for the closing fence starting at line 2 (index 1). The
        // first line is the opening fence; anything we slice as the
        // frontmatter block lives strictly between the two fence lines.
        for i in 1..<lines.count {
            let trimmed = lines[i].trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed == "---" {
                let frontmatterLines = lines[1..<i]
                let bodyLines = lines[(i + 1)...]
                let frontmatterRaw = frontmatterLines.joined(separator: "\n")
                let body = trimLeadingWhitespaceAndNewlines(
                    bodyLines.joined(separator: "\n")
                )
                return Split(frontmatterRaw: frontmatterRaw, body: body)
            }
        }

        // Unclosed fence — treat as no frontmatter. This matches the
        // desktop renderer's behavior and protects users from
        // accidentally hiding their entire document behind a
        // collapsible section by typing a stray `---` at the top.
        return Split(frontmatterRaw: nil, body: content)
    }

    // MARK: - Helpers

    /// Drop any leading whitespace or newline characters from `s`. This
    /// mirrors JavaScript's `String.prototype.trimStart` used by the
    /// desktop renderer, so the two clients return body strings that
    /// begin at the same character.
    private static func trimLeadingWhitespaceAndNewlines(_ s: String) -> String {
        var idx = s.startIndex
        while idx < s.endIndex,
              s[idx].isWhitespace || s[idx].isNewline
        {
            idx = s.index(after: idx)
        }
        return String(s[idx...])
    }
}

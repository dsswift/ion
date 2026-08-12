import SwiftUI
import XCTest
@testable import IonRemote

/// Type-role coverage — the guard for the defect class where a shipping view
/// picks a font size and weight on its own instead of naming an `IonType` role.
///
/// A call site that writes `.font(.system(size: 11))` makes a private decision
/// with no shared anchor and, critically, does not participate in Dynamic Type:
/// `Font.system(size:)` pins a point size and never scales. The eleven `IonType`
/// roles route through `UIFontMetrics.scaledFont(for:)` (and `Font.custom(
/// relativeTo:)` for the mono role), so a site that names a role scales and a
/// site that names a raw font does not. This test rejects the raw form in
/// shipping views, the same way `ThemeableSurfaceCoverageTests` guards opaque
/// system colors.
///
/// A reflection-based check cannot see what a view body renders, so this scans
/// the shipping source with `#if DEBUG` blocks stripped — Xcode Previews
/// legitimately use raw fonts, never ship, and are not part of this contract.
final class TypeRoleCoverageTests: XCTestCase {

    // MARK: - Source access

    private var sourceRoot: URL {
        // .../ios/IonRemoteTests/<thisfile> -> .../ios/IonRemote
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("IonRemote")
    }

    /// Every shipping `.swift` file under `Views/`, with `#if DEBUG` blocks
    /// stripped. Matches the `shippingSources()` helper in
    /// `ThemeableSurfaceCoverageTests`.
    private func shippingViewSources() throws -> [(path: String, body: String)] {
        let root = sourceRoot
        guard let walker = FileManager.default.enumerator(
            at: root, includingPropertiesForKeys: nil
        ) else {
            XCTFail("could not enumerate \(root.path)")
            return []
        }
        var out: [(String, String)] = []
        for case let url as URL in walker where url.pathExtension == "swift" {
            let relative = url.path.replacingOccurrences(of: root.path + "/", with: "")
            guard relative.hasPrefix("Views/") else { continue }
            let src = try String(contentsOf: url, encoding: .utf8)
            out.append((relative, Self.strippingDebugBlocks(src)))
        }
        XCTAssertFalse(out.isEmpty, "no Swift view sources found under \(root.path)/Views")
        return out
    }

    /// Drop `#if DEBUG ... #endif` regions. Nesting inside a DEBUG block is
    /// tracked so an inner `#if` does not end the region early. Mirrors the
    /// theme coverage test's stripper exactly.
    private static func strippingDebugBlocks(_ source: String) -> String {
        var kept: [String] = []
        var depth = 0
        for line in source.split(separator: "\n", omittingEmptySubsequences: false) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if depth > 0 {
                if trimmed.hasPrefix("#if") { depth += 1 }
                if trimmed.hasPrefix("#endif") { depth -= 1 }
                continue
            }
            if trimmed.hasPrefix("#if DEBUG") {
                depth = 1
                continue
            }
            kept.append(String(line))
        }
        return kept.joined(separator: "\n")
    }

    // MARK: - The raw-font ban

    /// The raw literal a shipping view must not use. A site that needs a
    /// genuinely non-role font — an SF Symbol sized via `.font`, a
    /// monospaced-digit counter locked to a fixed instrument row, a
    /// column-aligned diff grid — keeps its literal with a same-line
    /// `// design-type: <reason>` hatch, mirroring the theme scan's
    /// `theme-color-ok:` convention and the repo's nolint / silent-ok pattern:
    /// the exception stays visible, reasoned, and reviewed.
    private static let rawFontLiteral = ".font(.system("
    private static let escapeTag = "design-type:"

    func testNoShippingViewUsesARawSystemFont() throws {
        var offenders: [String] = []
        for (path, body) in try shippingViewSources() {
            for (offset, line) in body.split(
                separator: "\n", omittingEmptySubsequences: false
            ).enumerated() where line.contains(Self.rawFontLiteral)
                && !line.contains(Self.escapeTag) {
                offenders.append("\(path):\(offset + 1) \(line.trimmingCharacters(in: .whitespaces))")
            }
        }
        XCTAssertEqual(
            offenders, [],
            """
            Raw system font in a shipping view. `.font(.system(...))` pins a point \
            size and does not participate in Dynamic Type. Name an IonType role \
            instead via `.ionType(_:)`: mono (path, branch, ID, command, code), \
            body/bodyStrong (prose), rowTitle/rowTitleAttention (list titles), \
            sectionLabel/meaning/metadata (labels), microLabel (compact chips). If \
            the site genuinely needs a non-role font — an SF Symbol sized via \
            .font, a monospaced-digit counter on a fixed row, a column-aligned \
            grid — keep the literal with a same-line `// design-type: <reason>` \
            hatch that says why.
            """
        )
    }
}

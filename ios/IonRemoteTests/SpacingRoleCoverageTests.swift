import SwiftUI
import XCTest
@testable import IonRemote

/// Spacing role coverage — the guard for the defect class where a shipping view
/// insets or gaps a surface with a literal `.padding(N)` value instead of
/// naming an `IonSpace` role.
///
/// This is the narrower of the geometry gates, by design (design-system spec §2
/// item 4). A raw `.padding(` is not banned outright: native geometry that is
/// genuinely off the 4pt ratio scale — a 6pt nudge, a 10pt gap, a 2pt tight
/// inset — may stay explicit, provided it carries a same-line
/// `// design-geometry: <reason>` hatch. What the gate rejects is an
/// *un-reasoned* literal: an on-scale value (4, 8, 12, 16, 24, 32) belongs to a
/// role (hairlineGap … screenInset), and any other literal must state why it is
/// off the rhythm. The hatch keeps the exception visible, reasoned, and
/// reviewed, mirroring the `theme-color-ok:` / `design-type:` convention.
///
/// A reflection-based check cannot see what a view body renders, so this scans
/// shipping source with `#if DEBUG` blocks stripped, matching
/// `ThemeableSurfaceCoverageTests`.
final class SpacingRoleCoverageTests: XCTestCase {

    // MARK: - Source access

    private var sourceRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("IonRemote")
    }

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

    // MARK: - The un-reasoned-literal ban

    private static let escapeTag = "design-geometry:"

    func testNoShippingViewUsesAnUnreasonedLiteralPadding() throws {
        // A numeric `.padding(` argument, either the bare `.padding(8)` or the
        // edge form `.padding(.horizontal, 8)`. A value reached through
        // `IonSpace.` is already a role and never matches this literal pattern.
        let literal = try Regex(#"\.padding\((?:\.[a-zA-Z]+,\s*)?[0-9]+(?:\.[0-9]+)?\)"#)
        var offenders: [String] = []
        for (path, body) in try shippingViewSources() {
            for (offset, line) in body.split(
                separator: "\n", omittingEmptySubsequences: false
            ).enumerated() where line.contains(literal) && !line.contains(Self.escapeTag) {
                offenders.append("\(path):\(offset + 1) \(line.trimmingCharacters(in: .whitespaces))")
            }
        }
        XCTAssertEqual(
            offenders, [],
            """
            Un-reasoned literal padding in a shipping view. An on-scale value \
            belongs to an IonSpace role: hairlineGap (4), compactGap (8), \
            contentGap (12), rowInset (16), sectionGap (24), screenInset (32). \
            A value off the 4pt ratio scale may stay literal only with a \
            same-line `// design-geometry: <reason>` hatch that says why it is \
            off the rhythm.
            """
        )
    }
}

import SwiftUI
import XCTest
@testable import IonRemote

/// Corner-radius role coverage — the guard for the defect class where a
/// shipping view rounds a surface with a literal `cornerRadius:` value instead
/// of naming an `IonRadius` role.
///
/// A call site that writes `RoundedRectangle(cornerRadius: 8)` makes a private
/// decision with no shared rule, which is how the four-step `IonTheme.Radius`
/// scale drifted (`medium` and `large` picked interchangeably for the same
/// surface). The three `IonRadius` roles — control (8), container (12),
/// sheet (20) — tie a radius to what it encloses, so a site names the enclosure
/// rather than a number. This test rejects the literal form in shipping views,
/// the same way `TypeRoleCoverageTests` rejects raw fonts.
///
/// `0` and `1` are exempt: a square corner and a 1pt hairline rounding are not
/// role-bearing surface geometry (design-system spec §2 item 5). Any other
/// literal — a 1.5pt bar, a 3pt micro-pill, a 4pt gauge — that genuinely needs
/// sub-control geometry keeps its value with a same-line
/// `// design-geometry: <reason>` hatch.
///
/// A reflection-based check cannot see what a view body renders, so this scans
/// shipping source with `#if DEBUG` blocks stripped, matching
/// `ThemeableSurfaceCoverageTests`.
final class RadiusRoleCoverageTests: XCTestCase {

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

    // MARK: - The literal-radius ban

    private static let escapeTag = "design-geometry:"

    func testNoShippingViewUsesALiteralCornerRadius() throws {
        // A numeric `cornerRadius:` argument. `0` and `1` are exempt (square
        // corner / 1pt hairline are not role-bearing geometry); a value
        // reached through `IonRadius.` is already a role and never matches
        // this literal pattern.
        let literal = try Regex(#"cornerRadius:\s*([0-9]+(?:\.[0-9]+)?)"#)
        var offenders: [String] = []
        for (path, body) in try shippingViewSources() {
            for (offset, line) in body.split(
                separator: "\n", omittingEmptySubsequences: false
            ).enumerated() {
                guard !line.contains(Self.escapeTag) else { continue }
                for match in line.matches(of: literal) {
                    guard let captured = match.output[1].substring else { continue }
                    let value = String(captured)
                    if value == "0" || value == "1" { continue }
                    offenders.append("\(path):\(offset + 1) cornerRadius: \(value)")
                }
            }
        }
        XCTAssertEqual(
            offenders, [],
            """
            Literal corner radius in a shipping view. Name an IonRadius role \
            instead: control (8 — compact button, chip, code table), container \
            (12 — row, permission card, user bubble, inline tool well), or sheet \
            (20 — sheet, composer pill). `0` and `1` are exempt as non-role \
            geometry. If the site genuinely needs a sub-control radius — a \
            hairline bar, a micro-pill, a gauge — keep the literal with a \
            same-line `// design-geometry: <reason>` hatch that says why.
            """
        )
    }
}

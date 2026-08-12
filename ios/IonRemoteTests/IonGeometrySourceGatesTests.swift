import XCTest
@testable import IonRemote

/// Source gate for the iOS geometry vocabulary (`IonSpace`, `IonRadius`,
/// `IonType`): the three enums are CLOSED sets, and this pins the exact members
/// each one declares. It is the guard against an INVENTED role name — the class
/// where a dispatch adds `IonSpace.stackGap`/`containerInset`/`rowGap`/
/// `inlineGap` to the vocabulary and threads it through the view layer, growing
/// the scale nobody agreed to grow.
///
/// Why freeze the declared SET rather than check call sites. The obvious gate —
/// "reject a call site naming a member the enum does not declare" — is vacuous:
/// an *undeclared* `IonSpace.stackGap` is a Swift COMPILE error, caught before
/// any test runs, so that gate can never fail as a test and proves nothing. The
/// invented-name defect only reaches a green compile (and thus a silent
/// vocabulary drift) when the new name is *declared* in the enum AND used. The
/// compiler is happy with that; only pinning the declared set catches it. So
/// this gate parses the members actually declared in each geometry source and
/// asserts they equal the frozen guide set. Add a role, rename one, or drop one
/// and this fails, naming the exact drift — the probe that proves it has teeth.
///
/// The sibling `IonSpaceTests` / `IonTypeTests` pin the VALUES of the known
/// roles (rowInset == 16, body == 16pt). This gate pins that no role exists
/// BEYOND them. The two are complementary: a value test cannot see a newly
/// added role, and a set test cannot see a drifted value.
///
/// Three further gates from the style guide (section 2, items 3-5) are NOT here
/// yet, because each is coupled to the COMPLETION of a call-site conversion that
/// has not landed in the shipping view layer. Adding a gate before its
/// conversion lands would ship a red branch (the guide's staging note forbids
/// exactly that), and weakening the gate to pass — or allowlisting the
/// unconverted sites — is documenting the defect instead of fixing it:
///
///   - Raw `.font(.system(` ban (item 3) — pending: 69 shipping sites (`#if
///     DEBUG` stripped) still resolve fonts with `.font(.system(...))` and must
///     first move to an `IonType` role. Each is a semantic role decision.
///   - Raw `.padding(<number>)` needing a `// design-geometry:` hatch (item 4)
///     — pending: 292 shipping sites still pass a numeric padding.
///   - Literal corner-radius ban (item 5) — pending: the `.cornerRadius(`
///     modifier form is already clean (0 sites), but the LIVE idiom is
///     `RoundedRectangle(cornerRadius: <n>)` with 34 shipping sites, several
///     carrying values (1.5, 3, 4, 6, 10) that do not map to the three
///     IonRadius roles (8/12/20). Closing it is a design conversion.
///
/// Those three land WITH their conversions. Adding them now would fail CI or
/// force a wall of escape hatches, which is how a gate stops meaning anything.
final class IonGeometrySourceGatesTests: XCTestCase {

    // MARK: - Source access (same idiom as ThemeableSurfaceCoverageTests)

    private var sourceRoot: URL {
        // .../ios/IonRemoteTests/<thisfile> -> .../ios/IonRemote
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("IonRemote")
    }

    /// Drop `#if DEBUG ... #endif` regions, tracking nesting so an inner `#if`
    /// does not end the region early. Matches the existing coverage gate.
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

    /// Drop a `//` line comment so a name that appears only in prose (a doc
    /// comment describing a role) is never counted as a declaration.
    private static func strippingLineComment(_ line: Substring) -> String {
        if let range = line.range(of: "//") {
            return String(line[line.startIndex..<range.lowerBound])
        }
        return String(line)
    }

    // MARK: - Frozen vocabularies (from the iOS style guide, section 2 / 4)

    /// IonSpace declares six rhythm roles plus a nested `Metric` enum. The
    /// parser flattens both levels, so the frozen set includes the `Metric`
    /// members and the enum name itself.
    private static let expectedIonSpace: Set<String> = [
        // The top-level enum name (the parser sees the `enum IonSpace` decl).
        "IonSpace",
        // Rhythm roles.
        "hairlineGap", "compactInset", "compactGap", "contentGap", "rowInset", "sectionGap", "screenInset",
        // Nested Metric enum (name + members).
        "Metric",
        "tabRowHeight", "tabRowVerticalPadding", "standardRowHeight",
        "sectionHeaderHeight", "sectionHeaderTopPadding",
        "tabRowLeadingGutter", "tabRowTrailingGutter",
        "assistantTurnGap", "assistantDocumentGutter", "toolLineInset",
        "composerBottomOffset", "statusColumnWidth", "compactStatusDiameter",
    ]

    /// IonRadius declares exactly three enclosure roles.
    private static let expectedIonRadius: Set<String> = [
        "IonRadius",
        "control", "container", "sheet",
    ]

    /// IonType declares the eleven type roles as `static var`s, mirrored by the
    /// `Role` enum's eleven cases plus its helper `func`s. The parser sees the
    /// static vars, the nested `Role` enum name and cases, and the helpers.
    private static let expectedIonType: Set<String> = [
        "IonType",
        // The eleven roles as static vars.
        "screenTitleLarge", "screenTitleInline", "rowTitle", "rowTitleAttention",
        "body", "bodyStrong", "sectionLabel", "meaning", "metadata", "mono", "microLabel",
        // Role enum name + its eleven cases (same names as the vars).
        "Role",
        // Helper funcs on IonType.
        "font", "size", "lineHeight", "textStyle", "compactSelectionLabel", "compactSelectionWeight", "scaled",
    ]

    func testIonSpaceDeclaresExactlyTheFrozenRoleSet() throws {
        XCTAssertEqual(
            try declaredMembers("Views/IonSpace.swift"), Self.expectedIonSpace,
            """
            IonSpace's declared members drifted from the frozen guide set. A new \
            member is an invented spacing role (the guide names a fixed scale); \
            a removed or renamed one breaks a live call site. Reconcile the \
            source with the guide, or update this frozen set WITH the guide \
            change that justifies it.
            """
        )
    }

    func testIonRadiusDeclaresExactlyTheFrozenRoleSet() throws {
        XCTAssertEqual(
            try declaredMembers("Views/IonRadius.swift"), Self.expectedIonRadius,
            """
            IonRadius's declared members drifted from the frozen guide set of \
            three enclosure roles (control 8, container 12, sheet 20). A fourth \
            role is exactly the choice-with-no-rule the three-step scale exists \
            to end.
            """
        )
    }

    func testIonTypeDeclaresExactlyTheFrozenRoleSet() throws {
        XCTAssertEqual(
            try declaredMembers("Views/IonType.swift"), Self.expectedIonType,
            """
            IonType's declared members drifted from the frozen guide set of \
            eleven type roles. A new role is an invented type style; a removed \
            one breaks a live call site.
            """
        )
    }

    /// The `Role` enum's cases must match the eleven type-role names exactly, so
    /// a role added as a `static var` without a `Role` case (or vice versa) is
    /// caught rather than silently half-wired.
    func testIonTypeRoleCasesMatchTheErRoleVars() throws {
        let expectedCases: Set<String> = [
            "screenTitleLarge", "screenTitleInline", "rowTitle", "rowTitleAttention",
            "body", "bodyStrong", "sectionLabel", "meaning", "metadata", "mono", "microLabel",
        ]
        XCTAssertEqual(
            Set(IonType.Role.allCases.map(\.rawValue)), expectedCases,
            "IonType.Role cases drifted from the eleven frozen type roles"
        )
    }

    /// Parse the declared member names of a geometry enum source: every
    /// `static let/var/func`, nested `enum`, and `case`. `#if DEBUG` regions and
    /// `//` comments are stripped so only real declarations are counted.
    private func declaredMembers(_ relativePath: String) throws -> Set<String> {
        let url = sourceRoot.appendingPathComponent(relativePath)
        let src = Self.strippingDebugBlocks(try String(contentsOf: url, encoding: .utf8))
        var names: Set<String> = []
        let patterns = [
            #"\bstatic\s+(?:let|var|func)\s+([A-Za-z_][A-Za-z0-9_]*)"#,
            #"\benum\s+([A-Za-z_][A-Za-z0-9_]*)"#,
            #"\bcase\s+([A-Za-z_][A-Za-z0-9_]*)"#,
        ]
        for pattern in patterns {
            let re = try Regex(pattern)
            for line in src.split(separator: "\n", omittingEmptySubsequences: false) {
                let code = Self.strippingLineComment(line)
                for match in code.matches(of: re) {
                    if let name = match.output[1].substring.map(String.init) {
                        names.insert(name)
                    }
                }
            }
        }
        XCTAssertFalse(names.isEmpty, "no declarations parsed from \(relativePath)")
        return names
    }
}

import SwiftUI
import XCTest
@testable import IonRemote

/// Themeable surface coverage — the guard for the defect class where a
/// shipping view paints an opaque UIKit system color that no theme pack can
/// reach.
///
/// `Color(.systemBackground)` and friends resolve from the system light/dark
/// setting, not from the active `AppTheme`. A view that paints one renders the
/// same gray (or black) under every theme, so a pack's surface tokens have no
/// effect there. The reported symptom was the tab list rendering on a black
/// background instead of the theme's; the same defect existed at every other
/// site enumerated below.
///
/// A reflection-based check cannot see what a view body paints, so this scans
/// the shipping source the same way `UnifiedConversationDivergenceGuardTests`
/// guards removed declarations.
final class ThemeableSurfaceCoverageTests: XCTestCase {

    // MARK: - Source access

    private var sourceRoot: URL {
        // .../ios/IonRemoteTests/<thisfile> -> .../ios/IonRemote
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("IonRemote")
    }

    /// Every shipping `.swift` file under the app target, with `#if DEBUG`
    /// blocks stripped. Xcode Previews legitimately use system colors — they
    /// never ship and have no theme environment injected — so they are not
    /// part of this contract.
    private func shippingSources() throws -> [(path: String, body: String)] {
        let root = sourceRoot
        guard let walker = FileManager.default.enumerator(
            at: root, includingPropertiesForKeys: nil
        ) else {
            XCTFail("could not enumerate \(root.path)")
            return []
        }
        var out: [(String, String)] = []
        for case let url as URL in walker where url.pathExtension == "swift" {
            let src = try String(contentsOf: url, encoding: .utf8)
            let relative = url.path.replacingOccurrences(of: root.path + "/", with: "")
            out.append((relative, Self.strippingDebugBlocks(src)))
        }
        XCTAssertFalse(out.isEmpty, "no Swift sources found under \(root.path)")
        return out
    }

    /// Drop `#if DEBUG ... #endif` regions. Nesting inside a DEBUG block is
    /// tracked so an inner `#if` does not end the region early.
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

    // ─── Gate scope: which bypass categories this file guards ────────────────
    //
    // Five distinct categories of AppTheme bypass exist in the iOS view layer.
    // This file does not guard all five, and the difference between "banned"
    // and "not banned" is a decision per category, never an oversight. Read
    // this list before assuming an unguarded category is a permitted one.
    //
    //   BANNED, enforced below:
    //     - Opaque UIKit surface colors (systemBackground, systemGray*, ...)
    //       — see `bannedColors`.
    //     - `Color(.separator)` — a visual border, which must resolve to
    //       `theme.borderSubtle`. Unlike a translucent fill it cannot retain
    //       the active pack's intended contrast.
    //     - Static `Color(hex: 0x...)` in Views/ — see
    //       `testStaticHexColorInViewsHasThemeTokenOrReasonedEscapeHatch`.
    //     - Qualified named palette hues (`Color.orange`, `Color.gray`, ...) in
    //       Views/ — see `testQualifiedNamedColorInViewsHasThemeTokenOrHatch`.
    //
    //   PERMITTED on the merits, not by omission:
    //     - `.primary` / `.secondary` / `.tertiary` are Apple's adaptive
    //       semantic foreground roles. They already track light/dark and are
    //       not fixed palette values, so banning them would replace a working
    //       adaptive behavior with a static token.
    //     - `Color.clear` is the absence of paint, not a palette value. There
    //       is no token for "nothing" and no theme could supply one.
    //     - `*SystemFill` colors are composited translucent overlays, and
    //       materials are live blurs sampling themed content beneath them.
    //       Flattening either to an opaque token deletes the translucency or
    //       the blur outright.
    //     - `Color(hex: someVariable)` carries user- or desktop-supplied
    //       runtime data (a user-chosen pill color, a desktop graph lane), not
    //       a source-defined palette value, so there is nothing to tokenize.
    //
    //   NOT YET BANNED — deliberately out of this gate's scope:
    //     - The BARE-DOT spelling of a named color (`.orange`, `.red`,
    //       `.green` as a `Color`-inferred argument: `.foregroundStyle(.red)`,
    //       `.tint(.orange)`, `case .added: return .green`). This is the same
    //       defect class as the qualified form banned below, and it is far
    //       larger — roughly 120 sites across Views/, concentrated in the git
    //       surfaces, worktree rows, and toast/status helpers.
    //
    //       It is excluded for one reason only: the qualified form was
    //       resolvable in full, and this one is not yet. Most bare-dot sites
    //       need roles AppTheme does not declare — `borderStrong`, an
    //       active-warning hue distinct from `statusRunning`, a gauge track,
    //       git add/modify/delete diff hues, an agent-kind palette. Banning
    //       the category before those tokens exist would produce a wall of
    //       escape hatches, which is how a gate stops meaning anything.
    //
    //       A gate is only worth its assertion if the category behind it is
    //       actually clean, so this one bans the half that is and says plainly
    //       that the other half is not. An unhatched bare-dot named color is an
    //       unresolved question, NOT an approved pattern.

    // MARK: - The opaque-system-color ban

    /// UIKit surfaces that bypass AppTheme. `Color(.separator)` is a visual
    /// border, so it must use `theme.borderSubtle`; unlike translucent fills,
    /// it cannot retain the active pack's intended contrast. `*SystemFill`
    /// surfaces and materials stay exempt: fills are composited overlays and
    /// materials are live blurs of their themed content. Replacing either with
    /// an opaque token would delete its platform-specific translucency or blur.
    private static let bannedColors = [
        "Color(.systemBackground)",
        "Color(.secondarySystemBackground)",
        "Color(.tertiarySystemBackground)",
        "Color(.systemGroupedBackground)",
        "Color(.secondarySystemGroupedBackground)",
        "Color(.tertiarySystemGroupedBackground)",
        "Color(.systemGray)",
        "Color(.systemGray2)",
        "Color(.systemGray3)",
        "Color(.systemGray4)",
        "Color(.systemGray5)",
        "Color(.systemGray6)",
        "Color(.separator)",
    ]

    /// Same-line escape hatch for a literal that is genuinely theme-neutral,
    /// mirroring the desktop scan's `// hardcoded-ok: <reason>` convention and
    /// the repo's nolint / silent-ok pattern: the exception stays visible,
    /// reasoned, and reviewed rather than silently permitted.
    private static let themeColorEscapeTag = "theme-color-ok:"

    func testNoShippingViewPaintsAnOpaqueSystemColor() throws {
        var offenders: [String] = []
        for (path, body) in try shippingSources() {
            for (offset, line) in body.split(
                separator: "\n", omittingEmptySubsequences: false
            ).enumerated() {
                for banned in Self.bannedColors where line.contains(banned) {
                    offenders.append("\(path):\(offset + 1) \(banned)")
                }
            }
        }
        XCTAssertEqual(
            offenders, [],
            """
            Opaque system color in shipping code. These resolve from the system \
            light/dark setting, not the active AppTheme, so a theme pack cannot \
            reach the surface. Use the matching token instead: surfaceSecondary \
            (rows, chips, headers, gutters), surfaceSunken (panes below the \
            container), borderSubtle (hairlines), textTertiary (muted text).
            """
        )
    }

    func testStaticHexColorInViewsHasThemeTokenOrReasonedEscapeHatch() throws {
        var offenders: [String] = []
        let literal = try Regex(#"Color\(hex:\s*0x[0-9A-Fa-f]+"#)
        for (path, body) in try shippingSources() where path.hasPrefix("Views/") {
            for (offset, line) in body.split(
                separator: "\n", omittingEmptySubsequences: false
            ).enumerated() where line.contains(literal) && !line.contains(Self.themeColorEscapeTag) {
                offenders.append("\(path):\(offset + 1) \(line.trimmingCharacters(in: .whitespaces))")
            }
        }
        XCTAssertEqual(
            offenders, [],
            """
            Static Color(hex:) value in a shipping view must use a matching AppTheme \
            token. If no existing token accurately represents its role, keep the \
            literal with a same-line `// theme-color-ok: <reason>` escape hatch.
            """
        )
    }

    /// The qualified-named-color ban. `Color.orange` and its siblings are fixed
    /// palette values: they resolve identically under every `AppTheme`, so a
    /// theme pack cannot reach the surface that paints one. This is the same
    /// defect as the opaque-system-color ban above, spelled differently.
    ///
    /// Scoped to the QUALIFIED spelling (`Color.orange`) because that half of
    /// the category is fully resolved. The bare-dot spelling (`.orange` as an
    /// inferred argument) is the same defect and is not yet banned — see the
    /// gate-scope note above for why, and do not read its absence as approval.
    ///
    /// `Color.clear` is exempt: the absence of paint is not a palette value.
    /// `Color.primary`/`.secondary`/`.tertiary` are exempt as Apple's adaptive
    /// semantic roles, per the same note.
    func testQualifiedNamedColorInViewsHasThemeTokenOrHatch() throws {
        let hues = [
            "red", "green", "blue", "orange", "yellow", "purple", "pink",
            "gray", "grey", "black", "white", "brown", "cyan", "mint",
            "teal", "indigo",
        ]
        // `.wordBoundaryKind(.simple)` is load-bearing, not decoration. Under
        // the default Unicode boundary kind, a trailing `\b` after an
        // alternation group does not match when the next character is `.`, so
        // `Color.blue.opacity(0.05)` — the single most common spelling of the
        // defect — silently passes while the bare `Color.blue` is caught. The
        // simple boundary kind matches on the word-character class and closes
        // that hole while still rejecting `UIColor.blue` and `Colorblue`.
        let named = try Regex("\\bColor\\.(" + hues.joined(separator: "|") + ")\\b")
            .wordBoundaryKind(.simple)
        var offenders: [String] = []
        for (path, body) in try shippingSources() where path.hasPrefix("Views/") {
            for (offset, line) in body.split(
                separator: "\n", omittingEmptySubsequences: false
            ).enumerated() where line.contains(named) && !line.contains(Self.themeColorEscapeTag) {
                offenders.append("\(path):\(offset + 1) \(line.trimmingCharacters(in: .whitespaces))")
            }
        }
        XCTAssertEqual(
            offenders, [],
            """
            A named palette color in a shipping view resolves the same under every \
            theme, so a theme pack cannot reach the surface. Use the AppTheme token \
            for the role: accent/accentSubtle (interactive), statusIdle (resting), \
            textTertiary (muted or disabled), surfaceSecondary (row and chip fills), \
            borderSubtle (hairlines), statusError/statusWarning (failure and \
            permission states). If the value is genuinely theme-neutral, or names a \
            role AppTheme does not yet declare, keep it with a same-line \
            `// theme-color-ok: <reason>` hatch that says which.
            """
        )
    }

    /// The reported defect, pinned at its own site: the tab list's layout roots
    /// must paint the theme surface. Before the fix the iPhone root painted a
    /// hardcoded `jarvis-hud` navy gated on `theme.backgroundView != nil`, so
    /// every other theme fell through to the system background.
    func testTabListLayoutRootsPaintTheThemeBackground() throws {
        let url = sourceRoot.appendingPathComponent("Views/TabListView+Layouts.swift")
        let src = try String(contentsOf: url, encoding: .utf8)
        // The iPhone root's ZStack opens with the themed fill, unconditionally.
        // Before the fix this was a hardcoded navy inside an `if theme
        // .backgroundView != nil` branch, so a theme without a decorative
        // backdrop painted nothing and fell through to the system background.
        // (Other `backgroundView != nil` gates in this file are legitimate:
        // the JARVIS toolbar title and the toolbar scrim over the animation.)
        //
        // Checked structurally rather than by exact string so comments and
        // reindentation inside the body do not fail the test: the first
        // statement after the iPhone root's `ZStack {` must be the fill.
        let iPhoneBody = try XCTUnwrap(
            src.components(separatedBy: "var iPhoneLayout: some View {").last,
            "iPhoneLayout not found"
        )
        let firstStatement = iPhoneBody
            .components(separatedBy: "ZStack {")[1]
            .split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .first { !$0.isEmpty && !$0.hasPrefix("//") }
        XCTAssertEqual(
            firstStatement, "theme.background.ignoresSafeArea()",
            """
            the iPhone tab-list root must open with an unconditional \
            theme.background fill; gating it on backgroundView leaves every \
            theme without a decorative backdrop on the system background.
            """
        )
        // Both iPad columns paint it too — they resolve separately, so one
        // modifier on the NavigationSplitView would miss the other column.
        XCTAssertEqual(
            src.components(separatedBy: ".background(theme.background.ignoresSafeArea())").count - 1,
            2,
            "both iPad split-view columns must paint theme.background"
        )
    }

    /// A themeable surface is not the same thing as a NEEDED surface. When the
    /// opaque-system-color sweep reached the tab-list section header, the header
    /// was given a filled `RoundedRectangle(theme.surfaceSecondary)` — which
    /// satisfied the rule above and simultaneously turned five quiet text labels
    /// into the heaviest elements on the screen.
    ///
    /// The correct fix for a section header is a transparent surface with themed
    /// TEXT, letting the list background show through. This pins that: reaching
    /// for a filled box to "make it themeable" is the regression, and the rule
    /// above must not be satisfiable that way again.
    func testSectionHeaderIsNotMadeThemeableWithAFilledSlab() throws {
        let url = sourceRoot.appendingPathComponent("Views/TabListGroupHeader.swift")
        let src = try String(contentsOf: url, encoding: .utf8)
        XCTAssertFalse(
            src.contains("RoundedRectangle"),
            """
            The tab-list section header must not paint a filled container. Theme \
            the header's TEXT (theme.textTertiary) and leave the surface \
            transparent — a slab competes with the rows the header labels.
            """
        )
    }

    /// No view may inline the `jarvis-hud` navy (or any other theme's palette
    /// value) as a literal. Two of these shipped in `TabListView`, painting one
    /// theme's background into a view every theme renders.
    func testNoViewInlinesTheJarvisNavyLiteral() throws {
        var offenders: [String] = []
        for (path, body) in try shippingSources() {
            // The jarvis-hud background, in the spellings the codebase used.
            for literal in ["red: 4/255, green: 14/255, blue: 28/255",
                            "red: 4 / 255, green: 14 / 255, blue: 28 / 255"]
            where body.contains(literal) {
                // ArcReactorBackground and the theme struct itself are where
                // this value legitimately lives.
                guard path != "Views/ArcReactorBackground.swift",
                      path != "Utilities/JarvisArcReactorTheme.swift" else { continue }
                offenders.append(path)
            }
        }
        XCTAssertEqual(
            offenders, [],
            "a theme's palette value is inlined in a shared view; read it from the theme instead"
        )
    }

    // MARK: - Token reachability

    /// Every token in the iOS contract must be reachable on a pack-supplied
    /// theme. `SyncedTheme` reads each token by string key, so a token added to
    /// the protocol but not to that reader silently renders the Ion Dark
    /// fallback for every pack — the `statusIdle` / `worktreeDirty` defect.
    func testSyncedThemeReadsEveryTokenFromTheWire() throws {
        let url = sourceRoot.appendingPathComponent("Utilities/SyncedTheme.swift")
        let src = try String(contentsOf: url, encoding: .utf8)
        for token in Self.iosTokenKeys + Self.iosOnlyTokenKeys {
            XCTAssertTrue(
                src.contains("color(\"\(token)\""),
                """
                SyncedTheme does not read `\(token)` from the payload, so every \
                theme pack renders the Ion Dark fallback for it. Add the \
                color("\(token)", ...) call and the matching key to \
                IOS_THEME_TOKEN_KEYS in desktop/src/shared/theme-pack-types.ts.
                """
            )
        }
    }

    /// A pack-supplied theme resolves every token to its own value, not the
    /// Ion Dark fallback. This is the behavioral half of the check above:
    /// it fails if a token is declared but never read off the wire.
    func testPackSuppliedThemeResolvesEveryTokenToItsOwnValue() throws {
        // A value no built-in uses, so any token that falls back is visible.
        let sentinel = "#123456FF"
        let allKeys = Self.iosTokenKeys + Self.iosOnlyTokenKeys
        let payload = SyncedThemePayload(
            id: "test-pack",
            name: "Test Pack",
            version: "1.0.0",
            tokens: Dictionary(uniqueKeysWithValues: allKeys.map { ($0, sentinel) }),
            base: nil,
            preferredColorScheme: "dark",
            assets: nil
        )
        let theme = SyncedTheme(payload: payload, store: SyncedThemeStore.shared)
        let expected = Color(rgbaHex: sentinel)
        XCTAssertNotNil(expected)
        for token in allKeys {
            let resolved = try tokenColor(theme, token)
            XCTAssertEqual(
                UIColor(resolved), UIColor(expected!),
                """
                \(token) did not take the pack's value — it fell back to Ion \
                Dark, so packs cannot theme this token.
                """
            )
        }
    }

    /// A pack that predates the iOS-only roles keeps its whole iOS component and
    /// falls back per token, rather than being rejected.
    ///
    /// The four iOS-only roles (statusQuestion, worktreeDirty, surfacePressed,
    /// borderStrong, overlayScrim) stay out of `IOS_THEME_TOKEN_KEYS`, so a
    /// baseless pack supplying the required set still loads and these fall back
    /// per token. If someone "tidies" SyncedTheme by making these non-optional
    /// reads, this test goes red.
    func testPackOmittingTheIosOnlyRolesStillResolvesTheRequiredSet() throws {
        let sentinel = "#123456FF"
        let payload = SyncedThemePayload(
            id: "legacy-pack",
            name: "Legacy Pack",
            version: "1.0.0",
            // Only the required set — exactly what a pack authored before these
            // roles existed ships.
            tokens: Dictionary(uniqueKeysWithValues: Self.iosTokenKeys.map { ($0, sentinel) }),
            base: nil,
            preferredColorScheme: "dark",
            assets: nil
        )
        let theme = SyncedTheme(payload: payload, store: SyncedThemeStore.shared)
        let expected = try XCTUnwrap(Color(rgbaHex: sentinel))

        for token in Self.iosTokenKeys {
            XCTAssertEqual(
                UIColor(try tokenColor(theme, token)), UIColor(expected),
                "\(token) is in the required set and must still take the pack's value"
            )
        }

        // The omitted roles fall back to Ion Dark, which is what keeps the pack
        // usable instead of rejected.
        let fallback = IonDarkTheme()
        for token in Self.iosOnlyTokenKeys {
            XCTAssertEqual(
                UIColor(try tokenColor(theme, token)),
                UIColor(try tokenColor(fallback, token)),
                "\(token) is not yet required, so an omitting pack must fall back to Ion Dark"
            )
        }
    }

    /// The iOS token contract. Mirrors `IOS_THEME_TOKEN_KEYS` in
    /// `desktop/src/shared/theme-pack-types.ts`; the parity fixture pins the
    /// values, this pins that every key is wired end to end.
    private static let iosTokenKeys = [
        "accent", "accentSubtle", "accentGlow", "background",
        "textPrimary", "textSecondary",
        "statusRunning", "statusDone", "statusError", "statusPending",
        "statusWaitingChildren", "statusBash", "statusWarning", "statusIdle",
        "worktreeDirty",
        "surfaceElevated", "surfaceSecondary", "surfaceSunken",
        "borderSubtle", "textTertiary",
        "codeBg", "userBubbleTint",
    ]

    /// Roles `AppTheme` declares that are deliberately NOT in the pack
    /// validator's required set yet.
    ///
    /// They are kept out of `iosTokenKeys` on purpose: that list mirrors
    /// `IOS_THEME_TOKEN_KEYS`, whose semantics are all-or-nothing (a pack
    /// missing any required key loses its entire iOS component,
    /// `theme-pack-types.ts:265-270`), so adding these four there would revoke
    /// the iOS half of every pack authored before they existed. They join the
    /// required set alongside base inheritance, which fills the gap safely.
    ///
    /// Until then these are still readable off the wire — a pack MAY supply
    /// them and a pack that omits them falls back per token. The two
    /// reachability tests below cover both lists for exactly that reason.
    private static let iosOnlyTokenKeys = [
        "statusQuestion", "surfacePressed", "borderStrong", "overlayScrim",
        "statusActiveWarning", "gaugeTrack", "statusStaff",
        "categoryTileConnection", "categoryTileAppearance", "categoryTileModels",
        "categoryTileVoice", "categoryTileDiagnostics",
    ]

    private func tokenColor(_ theme: any AppTheme, _ token: String) throws -> Color {
        switch token {
        case "accent": return theme.accent
        case "accentSubtle": return theme.accentSubtle
        case "accentGlow": return theme.accentGlow
        case "background": return theme.background
        case "textPrimary": return theme.textPrimary
        case "textSecondary": return theme.textSecondary
        case "statusRunning": return theme.statusRunning
        case "statusDone": return theme.statusDone
        case "statusError": return theme.statusError
        case "statusPending": return theme.statusPending
        case "statusWaitingChildren": return theme.statusWaitingChildren
        case "statusBash": return theme.statusBash
        case "statusWarning": return theme.statusWarning
        case "statusActiveWarning": return theme.statusActiveWarning
        case "gaugeTrack": return theme.gaugeTrack
        case "statusStaff": return theme.statusStaff
        case "categoryTileConnection": return theme.categoryTileConnection
        case "categoryTileAppearance": return theme.categoryTileAppearance
        case "categoryTileModels": return theme.categoryTileModels
        case "categoryTileVoice": return theme.categoryTileVoice
        case "categoryTileDiagnostics": return theme.categoryTileDiagnostics
        case "statusIdle": return theme.statusIdle
        case "statusQuestion": return theme.statusQuestion
        case "worktreeDirty": return theme.worktreeDirty
        case "surfaceElevated": return theme.surfaceElevated
        case "surfaceSecondary": return theme.surfaceSecondary
        case "surfaceSunken": return theme.surfaceSunken
        case "surfacePressed": return theme.surfacePressed
        case "borderSubtle": return theme.borderSubtle
        case "borderStrong": return theme.borderStrong
        case "overlayScrim": return theme.overlayScrim
        case "textTertiary": return theme.textTertiary
        case "codeBg": return theme.codeBg
        case "userBubbleTint": return theme.userBubbleTint
        default: throw CoverageError.unknownToken(token)
        }
    }

    private enum CoverageError: Error {
        case unknownToken(String)
    }
}

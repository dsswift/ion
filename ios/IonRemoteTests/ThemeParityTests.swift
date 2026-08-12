import SwiftUI
import XCTest
@testable import IonRemote

/// Cross-platform theme parity — iOS side.
///
/// The shared fixture (repo-root `assets/theme-parity.json`) pins the token
/// values of the shared built-in themes (ion-dark, ion-light, ion-classic).
/// This test asserts that each Swift theme struct resolves every AppTheme
/// color token to exactly the fixture's #RRGGBBAA value; the desktop half
/// is `desktop/src/renderer/theme/theme-parity.test.ts`. A Swift theme edit
/// that drifts from the fixture fails here until fixture + desktop palette
/// move in the same change.
final class ThemeParityTests: XCTestCase {

    // MARK: - Fixture loading (repo-relative; same idiom as ContractSyncTests)

    private struct ParityToken: Decodable {
        let desktopToken: String
        let hex: String
    }
    private struct ParityTheme: Decodable {
        let preferredColorScheme: String?
        let tokens: [String: ParityToken]
    }

    private func loadFixture() throws -> [String: ParityTheme] {
        let candidates = [
            "../assets/theme-parity.json",   // cwd = ios/
            "assets/theme-parity.json",      // cwd = repo root
        ]
        for candidate in candidates {
            let url = URL(fileURLWithPath: candidate)
            if FileManager.default.fileExists(atPath: url.path) {
                return try decodeFixture(Data(contentsOf: url))
            }
        }
        // Fallback: search up from this source file's location.
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<5 {
            dir = dir.deletingLastPathComponent()
            let candidate = dir.appendingPathComponent("assets/theme-parity.json")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try decodeFixture(Data(contentsOf: candidate))
            }
        }
        throw ParityError.fixtureNotFound
    }

    private func decodeFixture(_ data: Data) throws -> [String: ParityTheme] {
        // The fixture carries a top-level "_comment" string alongside the
        // theme entries; decode tolerantly and keep only theme objects.
        let raw = try JSONSerialization.jsonObject(with: data)
        guard let dict = raw as? [String: Any] else { throw ParityError.malformed }
        var out: [String: ParityTheme] = [:]
        for (key, value) in dict where value is [String: Any] {
            let themeData = try JSONSerialization.data(withJSONObject: value)
            out[key] = try JSONDecoder().decode(ParityTheme.self, from: themeData)
        }
        return out
    }

    private enum ParityError: Error {
        case fixtureNotFound
        case malformed
        case unknownToken(String)
    }

    // MARK: - Color extraction

    private func rgbaHex(_ color: Color) throws -> String {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        guard UIColor(color).getRed(&r, green: &g, blue: &b, alpha: &a) else {
            throw ParityError.malformed
        }
        func comp(_ v: CGFloat) -> String {
            String(format: "%02X", Int((v * 255).rounded()))
        }
        return "#\(comp(r))\(comp(g))\(comp(b))\(comp(a))"
    }

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
        case "statusIdle": return theme.statusIdle
        case "worktreeDirty": return theme.worktreeDirty
        case "surfaceElevated": return theme.surfaceElevated
        case "surfaceSecondary": return theme.surfaceSecondary
        case "surfaceSunken": return theme.surfaceSunken
        case "borderSubtle": return theme.borderSubtle
        case "textTertiary": return theme.textTertiary
        case "codeBg": return theme.codeBg
        case "userBubbleTint": return theme.userBubbleTint
        case "codeKeyword": return theme.codeKeyword
        case "codeString": return theme.codeString
        case "codeNumber": return theme.codeNumber
        case "codeComment": return theme.codeComment
        case "codeFunction": return theme.codeFunction
        case "codeType": return theme.codeType
        case "codeVariable": return theme.codeVariable
        case "codeOperator": return theme.codeOperator
        default: throw ParityError.unknownToken(token)
        }
    }

    // MARK: - Tests

    private func expectedColorScheme(for parity: ParityTheme) -> ColorScheme? {
        if parity.preferredColorScheme == "light" { return .light }
        if parity.preferredColorScheme == "dark" { return .dark }
        return nil
    }

    private func assertPreferredColorScheme(
        _ actual: ColorScheme?,
        matches parity: ParityTheme,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertEqual(actual, expectedColorScheme(for: parity), file: file, line: line)
    }

    func testAbsentFixtureSchemeDecodesToNilAndIsAccepted() throws {
        let parity = try JSONDecoder().decode(
            ParityTheme.self,
            from: Data("{\"tokens\":{}}".utf8)
        )
        XCTAssertNil(parity.preferredColorScheme)
        assertPreferredColorScheme(nil, matches: parity)
    }

    func testFixtureCoversTheSharedThemes() throws {
        let fixture = try loadFixture()
        XCTAssertEqual(
            fixture.keys.sorted(),
            ["ion-classic", "ion-contrast-dark", "ion-contrast-light",
             "ion-dark", "ion-light"],
            "fixture must cover exactly the shared built-in themes"
        )
    }

    func testSharedThemesMatchFixtureExactly() throws {
        let fixture = try loadFixture()
        for (themeId, parity) in fixture {
            let theme = ThemeRegistry.theme(for: themeId)
            XCTAssertEqual(theme.id, themeId, "theme \(themeId) must exist in the registry")

            assertPreferredColorScheme(theme.preferredColorScheme, matches: parity)

            for (token, entry) in parity.tokens {
                let actual = try rgbaHex(try tokenColor(theme, token))
                XCTAssertEqual(
                    actual, entry.hex.uppercased(),
                    "\(themeId).\(token) (desktop: \(entry.desktopToken))"
                )
            }
        }
    }

    func testRegistryContainsTheCrossPlatformThemeSet() {
        XCTAssertEqual(
            ThemeRegistry.themes.map(\.id),
            ["ion-dark", "ion-light", "ion-classic", "jarvis-hud",
             "ion-contrast-dark", "ion-contrast-light"]
        )
    }

    func testUnknownThemeIdFallsBackToIonDark() {
        XCTAssertEqual(ThemeRegistry.theme(for: "does-not-exist").id, "ion-dark")
        // The retired ion-default id resolves via fallback too (the
        // ThemeManager migration rewrites it before lookup in normal use).
        XCTAssertEqual(ThemeRegistry.theme(for: "ion-default").id, "ion-dark")
    }

    // MARK: - Tab-dot constants mirror Ion Dark

    /// `TabStatusRollup`'s dot constants are theme-independent literals, so
    /// nothing in the fixture pipeline pins them — they can silently drift
    /// away from the palette they claim to mirror. That drift is exactly what
    /// let the running dot sit ~5° of hue from the error dot when running
    /// moved to Ion Classic's terracotta. This test pins the block's stated
    /// invariant: every constant equals its Ion Dark theme token.
    ///
    /// `runningOrange` is the deliberate exception in one direction only: its
    /// value is shared verbatim by Ion Dark, Ion Light, and Ion Classic, so
    /// asserting it against Ion Dark also asserts it against the other two.
    func testTabDotConstantsMatchIonDarkTokens() throws {
        let dark = IonDarkTheme()
        let pairs: [(String, Color, Color)] = [
            ("errorColor/statusError", TabStatusRollup.errorColor, dark.statusError),
            ("permissionAmber/statusWarning", TabStatusRollup.permissionAmber, dark.statusWarning),
            ("childrenYellow/statusWaitingChildren", TabStatusRollup.childrenYellow, dark.statusWaitingChildren),
            ("runningOrange/statusRunning", TabStatusRollup.runningOrange, dark.statusRunning),
            ("shellPink/statusBash", TabStatusRollup.shellPink, dark.statusBash),
            ("idleGray/statusIdle", TabStatusRollup.idleGray, dark.statusIdle),
        ]
        for (label, constant, token) in pairs {
            XCTAssertEqual(
                try rgbaHex(constant), try rgbaHex(token),
                "TabStatusRollup.\(label) must equal its Ion Dark token"
            )
        }
    }

    /// The running dot must never collapse into the warm dots that sit beside
    /// it in the cascade. Terracotta running is close to a warm error red and
    /// an amber permission dot, and "working" reading as "dead" or "blocked"
    /// is the most misleading confusion the tab dot can produce. Inequality
    /// alone is too weak a guard for near hues, so this asserts a minimum
    /// hue separation.
    func testRunningDotStaysHueSeparatedFromWarmNeighbors() throws {
        func hue(_ color: Color) -> CGFloat {
            var h: CGFloat = 0, s: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
            UIColor(color).getHue(&h, saturation: &s, brightness: &b, alpha: &a)
            return h * 360
        }
        let running = hue(TabStatusRollup.runningOrange)
        for (label, other) in [
            ("error", TabStatusRollup.errorColor),
            ("permission", TabStatusRollup.permissionAmber),
            ("children", TabStatusRollup.childrenYellow),
        ] {
            let delta = abs(running - hue(other))
            XCTAssertGreaterThan(
                delta, 10,
                "running vs \(label) hue separation is only \(delta)° — too close to read apart"
            )
        }
    }
}

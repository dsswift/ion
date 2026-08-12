import SwiftUI
import XCTest
@testable import IonRemote

/// Base inheritance and color-scheme resolution for synced theme packs.
///
/// The desktop validator carries a partial iOS component with the `base` id it
/// inherits from (`required-when-partial`); iOS resolves the omitted tokens
/// from that compiled-in built-in theme. A complete component names no base and
/// inherits nothing. These tests pin both paths, plus the three-state
/// color-scheme resolution (light / dark / follow-system).
final class SyncedThemeInheritanceTests: XCTestCase {

    private func rgbaHex(_ color: Color) throws -> String {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        guard UIColor(color).getRed(&r, green: &g, blue: &b, alpha: &a) else {
            throw NSError(domain: "test", code: 1)
        }
        func comp(_ v: CGFloat) -> String { String(format: "%02X", Int((v * 255).rounded())) }
        return "#\(comp(r))\(comp(g))\(comp(b))\(comp(a))"
    }

    /// A partial payload that names `ion-light` as base inherits every omitted
    /// token from Ion Light — NOT from the hardcoded Ion Dark fallback. The one
    /// token the pack does supply takes its own value.
    func testPartialPayloadInheritsOmittedTokensFromNamedBase() throws {
        let sentinel = "#123456FF"
        let payload = SyncedThemePayload(
            id: "partial-pack",
            name: "Partial",
            version: "1.0.0",
            // Supplies only accent; everything else must inherit from ion-light.
            tokens: ["accent": sentinel],
            base: "ion-light",
            preferredColorScheme: nil,
            assets: nil
        )
        let theme = SyncedTheme(payload: payload, store: SyncedThemeStore.shared)
        let light = IonLightTheme()

        // Supplied token keeps its own value.
        XCTAssertEqual(try rgbaHex(theme.accent), try rgbaHex(Color(rgbaHex: sentinel)!))
        // Omitted tokens inherit from the NAMED base (Ion Light), proving the
        // fallback is no longer hardcoded Ion Dark.
        XCTAssertEqual(try rgbaHex(theme.background), try rgbaHex(light.background),
                       "background must inherit from the named base ion-light")
        XCTAssertEqual(try rgbaHex(theme.textPrimary), try rgbaHex(light.textPrimary),
                       "textPrimary must inherit from the named base ion-light")
        XCTAssertEqual(try rgbaHex(theme.statusError), try rgbaHex(light.statusError),
                       "statusError must inherit from the named base ion-light")
    }

    /// A baseless payload (the complete-required-set case) still falls back to
    /// Ion Dark for any absent optional token — the prior behavior.
    func testBaselessPayloadFallsBackToIonDark() throws {
        let payload = SyncedThemePayload(
            id: "baseless-pack",
            name: "Baseless",
            version: "1.0.0",
            tokens: ["accent": "#ABCDEFFF"],
            base: nil,
            preferredColorScheme: nil,
            assets: nil
        )
        let theme = SyncedTheme(payload: payload, store: SyncedThemeStore.shared)
        let dark = IonDarkTheme()
        XCTAssertEqual(try rgbaHex(theme.background), try rgbaHex(dark.background),
                       "a baseless payload falls back to Ion Dark for omitted tokens")
    }

    /// An unknown base id resolves to Ion Dark via ThemeRegistry — it can never
    /// recurse into another synced theme (the registry holds only built-ins).
    func testUnknownBaseFallsBackToIonDark() throws {
        let payload = SyncedThemePayload(
            id: "bad-base-pack",
            name: "Bad Base",
            version: "1.0.0",
            tokens: ["accent": "#ABCDEFFF"],
            base: "does-not-exist",
            preferredColorScheme: nil,
            assets: nil
        )
        let theme = SyncedTheme(payload: payload, store: SyncedThemeStore.shared)
        let dark = IonDarkTheme()
        XCTAssertEqual(try rgbaHex(theme.background), try rgbaHex(dark.background))
    }

    /// preferredColorScheme is a real three-state contract end to end: an
    /// omitted value resolves to nil (follow the system light/dark setting),
    /// distinct from an explicit "light" or "dark".
    func testColorSchemeResolvesAllThreeStates() {
        func scheme(_ raw: String?) -> ColorScheme? {
            SyncedTheme(payload: SyncedThemePayload(
                id: "s", name: "S", version: "1.0.0",
                tokens: ["accent": "#ABCDEFFF"], base: "ion-dark",
                preferredColorScheme: raw, assets: nil
            ), store: SyncedThemeStore.shared).preferredColorScheme
        }
        XCTAssertEqual(scheme("light"), .light)
        XCTAssertEqual(scheme("dark"), .dark)
        XCTAssertNil(scheme(nil), "omitted preferredColorScheme = follow the system setting")
        XCTAssertNil(scheme("bogus"), "an unrecognized value also resolves to follow-system")
    }
}

import SwiftUI

// MARK: - SyncedTheme

/// An AppTheme built from a `SyncedThemePayload` — the iOS component of a
/// custom theme pack installed on a paired desktop.
///
/// Tokens arrive as #RRGGBBAA hex strings (validated on the desktop before
/// they ride the wire; `color(_:)` still falls back to the Ion Dark value
/// for any token that fails to parse, so a malformed payload can never
/// render an unreadable app). A pack background asset renders as an
/// image-fill `backgroundView`; native effect renderers (Arc Reactor scan
/// line etc.) are reserved for built-in themes — synced themes are
/// tokens + images only.
struct SyncedTheme: AppTheme {
    let id: String
    let displayName: String

    let accent: Color
    let accentSubtle: Color
    let accentGlow: Color
    let background: Color
    let textPrimary: Color
    let textSecondary: Color
    let statusRunning: Color
    let statusDone: Color
    let statusError: Color
    let statusPending: Color
    let statusWaitingChildren: Color
    let statusWarning: Color
    let surfaceElevated: Color
    let codeBg: Color
    let userBubbleTint: Color

    let preferredColorScheme: ColorScheme?
    let activityIndicator: ((Bool) -> AnyView)? = nil

    /// Loaded from the SyncedThemeStore asset cache at construction time
    /// (assets are small — ≤3 MB — and themes reload rarely).
    private let backgroundImage: UIImage?
    let logoImage: UIImage?

    var backgroundView: AnyView? {
        guard let backgroundImage else { return nil }
        return AnyView(
            Image(uiImage: backgroundImage)
                .resizable()
                .scaledToFill()
                .ignoresSafeArea()
        )
    }

    init(payload: SyncedThemePayload, store: SyncedThemeStore = .shared) {
        id = payload.id
        displayName = payload.name

        let fallback = IonDarkTheme()
        func color(_ token: String, _ fallbackColor: Color) -> Color {
            guard let hex = payload.tokens[token], let parsed = Color(rgbaHex: hex) else {
                return fallbackColor
            }
            return parsed
        }
        accent = color("accent", fallback.accent)
        accentSubtle = color("accentSubtle", fallback.accentSubtle)
        accentGlow = color("accentGlow", fallback.accentGlow)
        background = color("background", fallback.background)
        textPrimary = color("textPrimary", fallback.textPrimary)
        textSecondary = color("textSecondary", fallback.textSecondary)
        statusRunning = color("statusRunning", fallback.statusRunning)
        statusDone = color("statusDone", fallback.statusDone)
        statusError = color("statusError", fallback.statusError)
        statusPending = color("statusPending", fallback.statusPending)
        statusWaitingChildren = color("statusWaitingChildren", fallback.statusWaitingChildren)
        statusWarning = color("statusWarning", fallback.statusWarning)
        surfaceElevated = color("surfaceElevated", fallback.surfaceElevated)
        codeBg = color("codeBg", fallback.codeBg)
        userBubbleTint = color("userBubbleTint", fallback.userBubbleTint)

        switch payload.preferredColorScheme {
        case "light": preferredColorScheme = .light
        case "dark": preferredColorScheme = .dark
        default: preferredColorScheme = nil
        }

        backgroundImage = store.assetData(themeId: payload.id, slot: "background").flatMap(UIImage.init(data:))
        logoImage = store.assetData(themeId: payload.id, slot: "logo").flatMap(UIImage.init(data:))
    }
}

// MARK: - Hex parsing (#RGB / #RRGGBB / #RRGGBBAA, sRGB)

extension Color {
    /// Failable parse of the theme-pack hex formats. Distinct from the
    /// non-failable `Color(hex: UInt)` initializer used by compiled-in
    /// themes — wire-supplied strings need the failure path.
    init?(rgbaHex: String) {
        var body = rgbaHex
        guard body.hasPrefix("#") else { return nil }
        body.removeFirst()
        if body.count == 3 {
            body = body.map { "\($0)\($0)" }.joined()
        }
        guard body.count == 6 || body.count == 8,
              body.allSatisfy({ $0.isHexDigit }),
              let value = UInt64(body, radix: 16) else { return nil }
        let r: Double, g: Double, b: Double, a: Double
        if body.count == 8 {
            r = Double((value >> 24) & 0xFF) / 255
            g = Double((value >> 16) & 0xFF) / 255
            b = Double((value >> 8) & 0xFF) / 255
            a = Double(value & 0xFF) / 255
        } else {
            r = Double((value >> 16) & 0xFF) / 255
            g = Double((value >> 8) & 0xFF) / 255
            b = Double(value & 0xFF) / 255
            a = 1
        }
        self.init(.sRGB, red: r, green: g, blue: b, opacity: a)
    }
}

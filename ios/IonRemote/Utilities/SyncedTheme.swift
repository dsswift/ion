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
    let statusBash: Color
    let statusWarning: Color
    let statusActiveWarning: Color
    let gaugeTrack: Color
    let statusStaff: Color
    let categoryTileConnection: Color
    let categoryTileAppearance: Color
    let categoryTileModels: Color
    let categoryTileVoice: Color
    let categoryTileDiagnostics: Color
    let statusIdle: Color
    let statusQuestion: Color
    let worktreeDirty: Color
    let surfaceElevated: Color
    let surfaceSecondary: Color
    let surfaceSunken: Color
    let surfacePressed: Color
    let borderSubtle: Color
    let borderStrong: Color
    let overlayScrim: Color
    let textTertiary: Color
    let codeBg: Color
    let userBubbleTint: Color
    let codeKeyword: Color
    let codeString: Color
    let codeNumber: Color
    let codeComment: Color
    let codeFunction: Color
    let codeType: Color
    let codeVariable: Color
    let codeOperator: Color

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

        let fallback = SyncedTheme.baseTheme(for: payload.base)
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
        statusBash = color("statusBash", fallback.statusBash)
        statusWarning = color("statusWarning", fallback.statusWarning)
        statusActiveWarning = color("statusActiveWarning", fallback.statusActiveWarning)
        gaugeTrack = color("gaugeTrack", fallback.gaugeTrack)
        statusStaff = color("statusStaff", fallback.statusStaff)
        categoryTileConnection = color("categoryTileConnection", fallback.categoryTileConnection)
        categoryTileAppearance = color("categoryTileAppearance", fallback.categoryTileAppearance)
        categoryTileModels = color("categoryTileModels", fallback.categoryTileModels)
        categoryTileVoice = color("categoryTileVoice", fallback.categoryTileVoice)
        categoryTileDiagnostics = color("categoryTileDiagnostics", fallback.categoryTileDiagnostics)
        statusIdle = color("statusIdle", fallback.statusIdle)
        // Every token the payload omits inherits from `fallback` — the
        // author-named `base` built-in (required-when-partial), or Ion Dark
        // when the payload names no base because it supplies the complete
        // required set. The desktop validator guarantees a baseless payload
        // carries every required token, so these fallbacks fire only for the
        // optional code-syntax tokens or an intentionally-inheriting partial.
        statusQuestion = color("statusQuestion", fallback.statusQuestion)
        worktreeDirty = color("worktreeDirty", fallback.worktreeDirty)
        surfaceElevated = color("surfaceElevated", fallback.surfaceElevated)
        surfaceSecondary = color("surfaceSecondary", fallback.surfaceSecondary)
        surfaceSunken = color("surfaceSunken", fallback.surfaceSunken)
        surfacePressed = color("surfacePressed", fallback.surfacePressed)
        borderSubtle = color("borderSubtle", fallback.borderSubtle)
        borderStrong = color("borderStrong", fallback.borderStrong)
        overlayScrim = color("overlayScrim", fallback.overlayScrim)
        textTertiary = color("textTertiary", fallback.textTertiary)
        codeBg = color("codeBg", fallback.codeBg)
        userBubbleTint = color("userBubbleTint", fallback.userBubbleTint)
        codeKeyword = color("codeKeyword", fallback.codeKeyword)
        codeString = color("codeString", fallback.codeString)
        codeNumber = color("codeNumber", fallback.codeNumber)
        codeComment = color("codeComment", fallback.codeComment)
        codeFunction = color("codeFunction", fallback.codeFunction)
        codeType = color("codeType", fallback.codeType)
        codeVariable = color("codeVariable", fallback.codeVariable)
        codeOperator = color("codeOperator", fallback.codeOperator)

        switch payload.preferredColorScheme {
        case "light": preferredColorScheme = .light
        case "dark": preferredColorScheme = .dark
        default: preferredColorScheme = nil
        }

        backgroundImage = store.assetData(themeId: payload.id, slot: "background").flatMap(UIImage.init(data:))
        logoImage = store.assetData(themeId: payload.id, slot: "logo").flatMap(UIImage.init(data:))
    }

    /// Resolve a payload's `base` id to the compiled-in built-in theme its
    /// omitted required tokens inherit from. nil (no base named — the payload
    /// supplies the complete required set) resolves to Ion Dark, matching the
    /// prior baseless behavior. An unknown id also falls back to Ion Dark via
    /// `ThemeRegistry`, which only ever contains built-ins, so this can never
    /// recurse into another SyncedTheme.
    private static func baseTheme(for base: String?) -> any AppTheme {
        guard let base else { return IonDarkTheme() }
        return ThemeRegistry.theme(for: base)
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

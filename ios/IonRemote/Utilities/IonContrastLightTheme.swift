import SwiftUI

// MARK: - IonContrastLightTheme

/// Ion Contrast Light — a static high-contrast light theme, the light half of
/// the contrast pair. Pins `preferredColorScheme` to `.light` and never follows
/// the system setting (style guide Section 5): high contrast is an explicit
/// accessibility choice, not an ambient preference.
///
/// The 23-role palette is ratified verbatim in the iOS style guide Section 5;
/// every hex here is copied unchanged. The eight additional priced roles come
/// from the ratified palette-additions document.
///
/// Desktop now ships `ion-contrast-light`, so this theme IS fixture-pinned
/// (`assets/theme-parity.json`).
///
/// Modal treatment: the light `overlayScrim` composites to 6.51:1 against the
/// sheet text and genuinely dims, so this theme keeps the scrim and needs no
/// borderStrong outline (style guide Section 5, condition d). The 1pt
/// `borderStrong` outline around every 6pt status shape still applies in both
/// contrast themes and is the conversation-surface conversion's render work.
struct IonContrastLightTheme: AppTheme {
    let id = "ion-contrast-light"
    let displayName = "Ion Contrast Light"

    // Accent. Alpha-derived subtle/glow follow the Ion Light pattern (0x1A/0x24).
    let accent = Color(hex: 0x1248C6)                        // 6.72:1 on surfaceElevated
    let accentSubtle = Color(hex: 0x1248C6, opacity: 0x1A / 255.0)
    let accentGlow = Color(hex: 0x1248C6, opacity: 0x24 / 255.0)

    // Surfaces + text (ratified, style guide Section 5).
    let background = Color(hex: 0xFFFFFF)                    // 18.55:1 vs textPrimary
    let textPrimary = Color(hex: 0x121318)
    let textSecondary = Color(hex: 0x303139)                 // 11.45:1 on surfaceElevated

    // Status roles (ratified). Shape fills only, never text foregrounds.
    let statusRunning = Color(hex: 0xA23D18)                 // 5.78:1
    let statusDone = Color(hex: 0x006B45)                    // 5.83:1
    let statusError = Color(hex: 0xB42318)                   // 5.82:1
    let statusPending = Color(hex: 0x4B4D57)                 // = statusIdle (base-theme pattern)
    let statusWaitingChildren = Color(hex: 0x785A00)         // 5.70:1
    let statusBash = Color(hex: 0xB0005A)                    // 6.21:1
    let statusWarning = Color(hex: 0x8A4B00)                 // 6.02:1
    let statusActiveWarning = Color(hex: 0x7A5410)           // 5.99:1
    let gaugeTrack = Color(hex: 0x7E8089)                    // 3.48:1 on surfaceElevated
    let statusStaff = Color(hex: 0x5930A5)                   // agent-kind violet (= statusQuestion)
    let categoryTileConnection = Color(hex: 0x12489C)        // 8.63:1 vs white glyph
    let categoryTileAppearance = Color(hex: 0x52308F)        // 9.64:1
    let categoryTileModels = Color(hex: 0x8A4B00)            // 6.80:1
    let categoryTileVoice = Color(hex: 0x005E3C)             // 7.88:1
    let categoryTileDiagnostics = Color(hex: 0x44464F)       // 9.40:1
    let statusIdle = Color(hex: 0x4B4D57)                    // 7.44:1
    let statusQuestion = Color(hex: 0x5930A5)               // 7.78:1
    let worktreeDirty = Color(hex: 0xB42318)                // git-status `!`

    let surfaceElevated = Color(hex: 0xF0F1F4)              // 16.42:1 vs textPrimary
    let surfaceSecondary = Color(hex: 0xE4E5EA)             // 14.75:1
    let surfaceSunken = Color(hex: 0xF5F5F7)               // 17.04:1
    let surfacePressed = Color(hex: 0xD6D7DE)              // 12.93:1
    let borderSubtle = Color(hex: 0x8A8C96)               // 2.96:1 — decorative hairline, tone-backed
    let borderStrong = Color(hex: 0x4B4D57)              // 7.44:1 — focus/selection boundary
    // 6.51:1 composited over surfaceElevated — a light theme's scrim genuinely
    // dims, so this one needs no borderStrong outline on the sheet.
    let overlayScrim = Color(hex: 0x000000, opacity: 0x66 / 255.0)
    let textTertiary = Color(hex: 0x4B4D57)               // 6.68:1 on surfaceSecondary
    let codeBg = Color(hex: 0xF5F5F7)                       // 17.04:1
    let userBubbleTint = Color(hex: 0xE4E5EA)              // 14.75:1

    // Code syntax. Not priced for the contrast pair; reuse the Ion Light code
    // palette — proven-readable on a light background identical in tone to this
    // theme's, rather than the monochrome protocol-extension defaults.
    let codeKeyword = Color(hex: 0x8E44AD)
    let codeString = Color(hex: 0x0A7A3E)
    let codeNumber = Color(hex: 0xB7791F)
    let codeComment = Color(hex: 0x8A8A93)
    let codeFunction = Color(hex: 0x2563EB)
    let codeType = Color(hex: 0x0E7C86)
    let codeVariable = Color(hex: 0xB4322A)
    let codeOperator = Color(hex: 0x4B4B52)

    let preferredColorScheme: ColorScheme? = .light
    let backgroundView: AnyView? = nil
    let activityIndicator: ((Bool) -> AnyView)? = nil
}

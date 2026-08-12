import SwiftUI

// MARK: - IonContrastDarkTheme

/// Ion Contrast Dark — a static high-contrast dark theme. Unlike a
/// system-adaptive theme, it pins its own `preferredColorScheme` to `.dark`
/// and never follows the system light/dark setting: a user who deliberately
/// selects high contrast should not have the palette reverse at sunset
/// (style guide Section 5). It is one half of the two-theme contrast pair
/// (`ion-contrast-dark` + `ion-contrast-light`); a single adaptive id is
/// mechanically impossible (SyncedTheme resolves one token map per id, and the
/// parity schema cannot express follow-system).
///
/// The 23-role palette is ratified verbatim in the iOS style guide Section 5;
/// every hex here is copied unchanged, with two independent WCAG
/// recomputations in agreement. The eight additional priced roles
/// (`statusActiveWarning`, `gaugeTrack`, `statusStaff`, and the five
/// `categoryTile` values) come from the ratified palette-additions document.
///
/// Excluded from the parity fixture only until desktop shipped its matching
/// pair; desktop now ships `ion-contrast-dark`, so this theme IS fixture-pinned
/// (`assets/theme-parity.json`).
///
/// Modal treatment: the dark `overlayScrim` composites to 1.09:1 and cannot
/// dim at any alpha, so modal separation is a 1pt `borderStrong` outline on the
/// sheet (style guide Section 5, condition d). `overlayScrim` stays in the
/// token set for tap-to-dismiss hit-testing. Applying the outline at the modal
/// render sites, and the 1pt `borderStrong` outline around every 6pt status
/// shape, is the conversation-surface conversion's work — the tokens ship here.
struct IonContrastDarkTheme: AppTheme {
    let id = "ion-contrast-dark"
    let displayName = "Ion Contrast Dark"

    // Accent. Alpha-derived subtle/glow follow the Ion Dark pattern (0x1F/0x2E).
    let accent = Color(hex: 0x80A7FF)
    let accentSubtle = Color(hex: 0x80A7FF, opacity: 0x1F / 255.0)
    let accentGlow = Color(hex: 0x80A7FF, opacity: 0x2E / 255.0)

    // Surfaces + text (ratified, style guide Section 5).
    let background = Color(hex: 0x000000)                     // 21.00:1 vs textPrimary
    let textPrimary = Color(hex: 0xFFFFFF)
    let textSecondary = Color(hex: 0xD7D7DE)                  // 12.83:1 on surfaceElevated

    // Status roles (ratified). Shape fills only, never text foregrounds.
    let statusRunning = Color(hex: 0xFF9A70)                  // 8.84:1
    let statusDone = Color(hex: 0x5CE6AE)                     // 11.71:1
    let statusError = Color(hex: 0xFF7B7B)                    // 7.32:1
    let statusPending = Color(hex: 0xBDBDC7)                  // = statusIdle (base-theme pattern)
    let statusWaitingChildren = Color(hex: 0xFFD45A)          // 12.96:1
    let statusBash = Color(hex: 0xFF6EB4)                     // 7.12:1
    let statusWarning = Color(hex: 0xFFC14D)                  // 11.36:1
    let statusActiveWarning = Color(hex: 0xFFD08A)            // 12.81:1
    let gaugeTrack = Color(hex: 0x626267)                     // 3.03:1 on surfaceElevated
    let statusStaff = Color(hex: 0xC3A6FF)                    // agent-kind violet (= statusQuestion)
    let categoryTileConnection = Color(hex: 0x2F5FBF)         // 5.98:1 vs white glyph
    let categoryTileAppearance = Color(hex: 0x6A4FB5)         // 6.18:1
    let categoryTileModels = Color(hex: 0xA85520)             // 5.27:1
    let categoryTileVoice = Color(hex: 0x1E7A50)              // 5.31:1
    let categoryTileDiagnostics = Color(hex: 0x4F5058)        // 8.01:1
    let statusIdle = Color(hex: 0xBDBDC7)                     // 9.86:1
    let statusQuestion = Color(hex: 0xC3A6FF)                 // 8.94:1
    let worktreeDirty = Color(hex: 0xFF9A70)                  // git-status `!`

    let surfaceElevated = Color(hex: 0x141418)               // 18.37:1 vs textPrimary
    let surfaceSecondary = Color(hex: 0x202126)              // 16.07:1
    let surfaceSunken = Color(hex: 0x0B0B0D)                 // 19.66:1
    let surfacePressed = Color(hex: 0x2C2D33)               // 13.72:1
    let borderSubtle = Color(hex: 0x5E6068)                 // 2.93:1 — decorative hairline, tone-backed
    let borderStrong = Color(hex: 0xBDBDC7)                 // 9.86:1 — focus/selection + dark modal outline
    // 1.09:1 composited over surfaceElevated — does not dim, so the modal
    // separator is a 1pt borderStrong outline and this is hit-testing only.
    let overlayScrim = Color(hex: 0x000000, opacity: 0x99 / 255.0)
    let textTertiary = Color(hex: 0xBDBDC7)                 // 8.62:1 on surfaceSecondary
    let codeBg = Color(hex: 0x0B0B0D)                        // 19.66:1
    let userBubbleTint = Color(hex: 0x202126)               // 16.07:1

    // Code syntax. Not priced for the contrast pair; reuse the Ion Dark code
    // palette — proven-readable on a near-black background identical in tone to
    // this theme's, rather than the monochrome protocol-extension defaults.
    let codeKeyword = Color(hex: 0xC792EA)
    let codeString = Color(hex: 0x98C379)
    let codeNumber = Color(hex: 0xF59E0B)
    let codeComment = Color(hex: 0x6B6B73)
    let codeFunction = Color(hex: 0x82AAFF)
    let codeType = Color(hex: 0x4EC9B0)
    let codeVariable = Color(hex: 0xE06C75)
    let codeOperator = Color(hex: 0xB9B9C0)

    let preferredColorScheme: ColorScheme? = .dark
    let backgroundView: AnyView? = nil
    let activityIndicator: ((Bool) -> AnyView)? = nil
}

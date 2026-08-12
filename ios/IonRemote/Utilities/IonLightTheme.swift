import SwiftUI

// MARK: - IonLightTheme

/// Ion Light — the light sibling of Ion Dark. Token values are mapped
/// from the desktop palette (`desktop/src/renderer/theme/palette-light.ts`)
/// and pinned by the shared parity fixture (`assets/theme-parity.json`).
/// Change values only alongside the fixture + desktop palette.
struct IonLightTheme: AppTheme {
    let id = "ion-light"
    let displayName = "Ion Light"

    let accent = Color(hex: 0x2B5FE8)                         // accent
    let accentSubtle = Color(hex: 0x2B5FE8, opacity: 0x1A / 255.0)  // accentLight
    let accentGlow = Color(hex: 0x2B5FE8, opacity: 0x24 / 255.0)    // accentSoft
    let background = Color(hex: 0xFBFBFC)                     // containerBg
    let textPrimary = Color(hex: 0x18181B)                    // textPrimary
    let textSecondary = Color(hex: 0x4B4B52)                  // textSecondary
    let statusRunning = Color(hex: 0xD97757)                  // statusRunning (terracotta orange, shared with Ion Dark + Classic)
    let statusDone = Color(hex: 0x059669)                     // statusComplete
    let statusError = Color(hex: 0xDC2626)                    // statusError
    let statusPending = Color(hex: 0x74747C)                  // statusIdle
    let statusWaitingChildren = Color(hex: 0xF59E0B)          // statusWaitingChildren
    let statusBash = Color(hex: 0xE6007A)                     // statusBash
    let statusWarning = Color(hex: 0xF59E0B)                  // statusWarning
    // Dark gold. A light theme must go DARKER to separate from an amber: a
    // lighter gold on a light surface loses both contrast and identity.
    // dE 36.9 from statusWarning, dE 37.7 from statusRunning. 4.40:1.
    let statusActiveWarning = Color(hex: 0x8F6B00)
    // 2.90:1 -- deliberately 0.10 under the 3:1 target, not an oversight. The
    // alternative that clears it (#74747C, 4.14:1) is byte-identical to this
    // theme's textTertiary AND its statusIdle, so it would paint a gauge track
    // in the exact hue of resting text and idle status: the semantic collision
    // the render site's own reasoning rejected. This value is still ~2.5x more
    // visible than the Color.gray.opacity(0.3) literal it replaces. It holds
    // only while the FILLED portion carries the reading; if a future design ever
    // makes the track the sole carrier of state, it must move to borderStrong.
    let gaugeTrack = Color(hex: 0x8E8E97)
    let statusStaff = Color(hex: 0x7C5CD6)                    // agent-kind violet (= statusQuestion)
    // Category tiles vs the white glyph; min pairwise dE 19.7.
    let categoryTileConnection = Color(hex: 0x2B5FE8)         // 5.38:1
    let categoryTileAppearance = Color(hex: 0x6D4BC0)         // 6.14:1
    let categoryTileModels = Color(hex: 0xA85D00)             // 4.96:1
    let categoryTileVoice = Color(hex: 0x057A52)              // 5.37:1
    let categoryTileDiagnostics = Color(hex: 0x5F6068)        // 6.25:1
    let statusIdle = Color(hex: 0x74747C)                     // statusIdle
    // Deeper violet than Ion Dark's, for legibility on a light surface (4.71:1).
    // Deliberately NOT the desktop's #7C3AED (pinned by palette-parity.test.ts),
    // which is why this role is not fixture-pinned -- see AppTheme.
    let statusQuestion = Color(hex: 0x7C5CD6)
    let worktreeDirty = Color(hex: 0xDC2626)                  // worktreeDirty (git-status `!`)
    let surfaceElevated = Color(hex: 0xF2F2F4)                // surfacePrimary
    let surfaceSecondary = Color(hex: 0xE9E9EC)               // surfaceSecondary
    let surfaceSunken = Color(hex: 0xF4F4F6)                  // containerBgCollapsed
    // One rung past surfaceSecondary, stepping DARKER because this is a light
    // theme (-6.33 L*). 12.93:1 against textPrimary.
    let surfacePressed = Color(hex: 0xD6D7DE)
    let borderSubtle = Color(hex: 0x000000, opacity: 0.06)    // borderSubtle
    let borderStrong = Color(hex: 0x4B4D57)                   // 5.60:1 on surfaceElevated
    // 2.81:1 composited over surfaceElevated -- a light theme's scrim genuinely
    // dims, so this one needs no borderStrong outline on the sheet.
    let overlayScrim = Color(hex: 0x000000, opacity: 0x66 / 255.0)
    let textTertiary = Color(hex: 0x74747C)                   // textTertiary
    let codeBg = Color(hex: 0xEEEEF1)                         // codeBg
    let userBubbleTint = Color(hex: 0xF2F2F4)                 // userBubble
    let codeKeyword = Color(hex: 0x8E44AD)                    // codeKeyword
    let codeString = Color(hex: 0x0A7A3E)                     // codeString
    let codeNumber = Color(hex: 0xB7791F)                     // codeNumber
    let codeComment = Color(hex: 0x8A8A93)                    // codeComment
    let codeFunction = Color(hex: 0x2563EB)                   // codeFunction
    let codeType = Color(hex: 0x0E7C86)                       // codeType
    let codeVariable = Color(hex: 0xB4322A)                   // codeVariable
    let codeOperator = Color(hex: 0x4B4B52)                   // codeOperator

    let preferredColorScheme: ColorScheme? = .light
    let backgroundView: AnyView? = nil
    let activityIndicator: ((Bool) -> AnyView)? = nil
}

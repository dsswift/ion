import SwiftUI

// MARK: - IonDarkTheme

/// Ion Dark — the cross-platform default theme. Token values are mapped
/// from the desktop palette (`desktop/src/renderer/theme/palette-dark.ts`)
/// and pinned by the shared parity fixture (`assets/theme-parity.json`,
/// asserted by ThemeParityTests on iOS and theme-parity.test.ts on
/// desktop). Change values only alongside the fixture + desktop palette.
struct IonDarkTheme: AppTheme {
    let id = "ion-dark"
    let displayName = "Ion Dark"

    let accent = Color(hex: 0x366FFB)                         // accent
    let accentSubtle = Color(hex: 0x366FFB, opacity: 0x1F / 255.0)  // accentLight
    let accentGlow = Color(hex: 0x366FFB, opacity: 0x2E / 255.0)    // accentSoft
    let background = Color(hex: 0x131316)                     // containerBg
    let textPrimary = Color(hex: 0xF5F5F5)                    // textPrimary
    let textSecondary = Color(hex: 0xB9B9C0)                  // textSecondary
    let statusRunning = Color(hex: 0xD97757)                  // statusRunning (terracotta orange, shared with Ion Light + Classic)
    let statusDone = Color(hex: 0x34D399)                     // statusComplete
    let statusError = Color(hex: 0xF87171)                    // statusError
    let statusPending = Color(hex: 0x818188)                  // statusIdle
    let statusWaitingChildren = Color(hex: 0xFBBF24)          // statusWaitingChildren
    let statusBash = Color(hex: 0xFF2D95)                     // statusBash
    let statusWarning = Color(hex: 0xF59E0B)                  // statusWarning
    // Gold, hue 36. dE 16.3 from statusWarning #F59E0B is the tightest pair in
    // this theme and clears the dE-15 bar with little margin -- the honest cost
    // of a palette already spending four values in the warm band. Pushing
    // further gold collides with statusWaitingChildren instead (dE 9.3), which
    // is worse: children-executing is a dot on these same screens, while
    // statusWarning renders as a triangle. 7.70:1 on surfaceElevated.
    let statusActiveWarning = Color(hex: 0xE8A33D)
    let gaugeTrack = Color(hex: 0x6A6A72)                     // 3.10:1 on surfaceElevated
    let statusStaff = Color(hex: 0xA78BFA)                    // agent-kind violet (= statusQuestion)
    // Category tiles, contrast against the white glyph. Models and Voice land at
    // 4.40:1 and 4.25:1 -- above the 3:1 that governs 14pt semibold, below the
    // stricter 4.5:1 design target; min pairwise dE across the set is 19.6.
    let categoryTileConnection = Color(hex: 0x3D6FD6)         // 4.73:1
    let categoryTileAppearance = Color(hex: 0x7A5CC4)         // 5.05:1
    let categoryTileModels = Color(hex: 0xB0653A)             // 4.40:1
    let categoryTileVoice = Color(hex: 0x2E8B57)              // 4.25:1
    let categoryTileDiagnostics = Color(hex: 0x5A5A63)        // 6.82:1
    let statusIdle = Color(hex: 0x818188)                     // statusIdle
    // Violet question dot. Same value the desktop carries in palette-dark.ts,
    // but not fixture-pinned: the light and classic themes deliberately differ,
    // so the role has no cross-platform value to pin (see AppTheme).
    let statusQuestion = Color(hex: 0xA78BFA)
    let worktreeDirty = Color(hex: 0xF87171)                  // worktreeDirty (git-status `!`)
    let surfaceElevated = Color(hex: 0x1E1E23)                // surfacePrimary
    let surfaceSecondary = Color(hex: 0x26262C)               // surfaceSecondary
    let surfaceSunken = Color(hex: 0x101013)                  // containerBgCollapsed
    // One rung past surfaceSecondary on this theme's tone ladder (+3.21 L*),
    // 13.72:1 against textPrimary.
    let surfacePressed = Color(hex: 0x2C2D33)
    let borderSubtle = Color(hex: 0xFFFFFF, opacity: 0.06)    // borderSubtle
    let borderStrong = Color(hex: 0xBDBDC7)                   // 7.24:1 on surfaceElevated
    // 1.18:1 composited over surfaceElevated -- does not dim, so the modal
    // separator is a 1pt borderStrong outline and this is hit-testing only.
    let overlayScrim = Color(hex: 0x000000, opacity: 0x99 / 255.0)
    let textTertiary = Color(hex: 0x818188)                   // textTertiary
    let codeBg = Color(hex: 0x0E0E11)                         // codeBg
    let userBubbleTint = Color(hex: 0x1E1E23)                 // userBubble
    let codeKeyword = Color(hex: 0xC792EA)                    // codeKeyword
    let codeString = Color(hex: 0x98C379)                     // codeString
    let codeNumber = Color(hex: 0xF59E0B)                     // codeNumber
    let codeComment = Color(hex: 0x6B6B73)                    // codeComment
    let codeFunction = Color(hex: 0x82AAFF)                   // codeFunction
    let codeType = Color(hex: 0x4EC9B0)                       // codeType
    let codeVariable = Color(hex: 0xE06C75)                   // codeVariable
    let codeOperator = Color(hex: 0xB9B9C0)                   // codeOperator

    let preferredColorScheme: ColorScheme? = .dark
    let backgroundView: AnyView? = nil
    let activityIndicator: ((Bool) -> AnyView)? = nil
}

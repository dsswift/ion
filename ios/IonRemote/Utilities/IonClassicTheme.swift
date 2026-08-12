import SwiftUI

// MARK: - IonClassicTheme

/// Ion Classic — the original warm-gray + orange Ion look. Token values are
/// mapped from the desktop palette
/// (`desktop/src/renderer/theme/palette-classic.ts`) and pinned by the
/// shared parity fixture (`assets/theme-parity.json`).
/// Change values only alongside the fixture + desktop palette.
struct IonClassicTheme: AppTheme {
    let id = "ion-classic"
    let displayName = "Ion Classic"

    let accent = Color(hex: 0xD97757)                         // accent
    let accentSubtle = Color(hex: 0xD97757, opacity: 0x1A / 255.0)  // accentLight
    let accentGlow = Color(hex: 0xD97757, opacity: 0x26 / 255.0)    // accentSoft
    let background = Color(hex: 0x242422)                     // containerBg
    let textPrimary = Color(hex: 0xCCC9C0)                    // textPrimary
    let textSecondary = Color(hex: 0xC0BDB2)                  // textSecondary
    let statusRunning = Color(hex: 0xD97757)                  // statusRunning
    let statusDone = Color(hex: 0x7AAC8C)                     // statusComplete
    let statusError = Color(hex: 0xC47060)                    // statusError
    let statusPending = Color(hex: 0x8A8A80)                  // statusIdle
    let statusWaitingChildren = Color(hex: 0xF59E0B)          // statusWaitingChildren
    let statusBash = Color(hex: 0xE0559B)                     // statusBash
    let statusWarning = Color(hex: 0xF59E0B)                  // statusWarning
    // Muted gold at 46% saturation, matching this theme's low-saturation
    // character. The cleanest separation of any theme: dE 43.5 from
    // statusWarning, dE 32.9 from statusRunning, because ion-classic mutes
    // everything else and a mid-saturation gold stands apart in it. 5.46:1.
    let statusActiveWarning = Color(hex: 0xC9A86A)
    let gaugeTrack = Color(hex: 0x7E7E76)                     // 3.01:1 on surfaceElevated
    let statusStaff = Color(hex: 0xA98FC4)                    // agent-kind violet
    // Category tiles vs the white glyph. Models 4.20:1 and Voice 3.86:1 clear
    // the 3:1 governing 14pt semibold; min pairwise dE 21.2.
    let categoryTileConnection = Color(hex: 0x4A6E9E)         // 5.23:1
    let categoryTileAppearance = Color(hex: 0x7A5F96)         // 5.38:1
    let categoryTileModels = Color(hex: 0xB4692F)             // 4.20:1
    let categoryTileVoice = Color(hex: 0x5E8C6A)              // 3.86:1
    let categoryTileDiagnostics = Color(hex: 0x6E6E64)        // 5.15:1
    let statusIdle = Color(hex: 0x8A8A80)                     // statusIdle
    // Muted violet, matching this theme's low-saturation character (36% sat
    // against Ion Dark's 92%). dE 60.6 from statusRunning and dE 37.6 from
    // statusPending, so the question dot is unmistakable beside either.
    let statusQuestion = Color(hex: 0xB49BD0)
    let worktreeDirty = Color(hex: 0xC47060)                  // worktreeDirty (git-status `!`)
    let surfaceElevated = Color(hex: 0x353530)                // surfacePrimary
    let surfaceSecondary = Color(hex: 0x42423D)               // surfaceSecondary
    let surfaceSunken = Color(hex: 0x21211E)                  // containerBgCollapsed
    // Next warm-gray rung past surfaceSecondary (+5.18 L*), holding the ladder's
    // warm bias (red = green, blue lower by 6). 5.06:1 against textPrimary.
    let surfacePressed = Color(hex: 0x4E4E48)
    let borderSubtle = Color(hex: 0x3B3B36)                   // borderSubtle
    let borderStrong = Color(hex: 0xA5A196)                   // 4.78:1 on surfaceElevated
    // 1.48:1 composited over surfaceElevated -- the least-bad of the dark themes
    // and still not dimming, so the sheet takes a 1pt borderStrong outline and
    // this stays hit-testing only.
    let overlayScrim = Color(hex: 0x000000, opacity: 0x99 / 255.0)
    let textTertiary = Color(hex: 0x76766E)                   // textTertiary
    let codeBg = Color(hex: 0x1A1A18)                         // codeBg
    let userBubbleTint = Color(hex: 0x353530)                 // userBubble
    let codeKeyword = Color(hex: 0xC99AC0)                    // codeKeyword
    let codeString = Color(hex: 0x7AAC8C)                     // codeString
    let codeNumber = Color(hex: 0xD9A05B)                     // codeNumber
    let codeComment = Color(hex: 0x8A8A80)                    // codeComment
    let codeFunction = Color(hex: 0xD97757)                   // codeFunction
    let codeType = Color(hex: 0x7AAC8C)                       // codeType
    let codeVariable = Color(hex: 0xC47060)                   // codeVariable
    let codeOperator = Color(hex: 0xC0BDB2)                   // codeOperator

    let preferredColorScheme: ColorScheme? = .dark
    let backgroundView: AnyView? = nil
    let activityIndicator: ((Bool) -> AnyView)? = nil
}

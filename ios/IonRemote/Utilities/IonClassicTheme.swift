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
    let statusIdle = Color(hex: 0x76766E)                     // statusIdle
    let worktreeDirty = Color(hex: 0xC47060)                  // worktreeDirty (git-status `!`)
    let surfaceElevated = Color(hex: 0x353530)                // surfacePrimary
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

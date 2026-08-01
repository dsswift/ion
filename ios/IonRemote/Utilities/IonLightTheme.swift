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
    let statusIdle = Color(hex: 0x8A8A80)                     // statusIdle
    let worktreeDirty = Color(hex: 0xDC2626)                  // worktreeDirty (git-status `!`)
    let surfaceElevated = Color(hex: 0xF2F2F4)                // surfacePrimary
    let codeBg = Color(hex: 0xEEEEF1)                         // codeBg
    let userBubbleTint = Color(hex: 0xF2F2F4)                 // userBubble

    let preferredColorScheme: ColorScheme? = .light
    let backgroundView: AnyView? = nil
    let activityIndicator: ((Bool) -> AnyView)? = nil
}

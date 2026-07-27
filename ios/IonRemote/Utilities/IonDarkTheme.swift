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
    let statusRunning = Color(hex: 0x5EA9C9)                  // statusRunning (steel-teal, distinct from accent)
    let statusDone = Color(hex: 0x34D399)                     // statusComplete
    let statusError = Color(hex: 0xF87171)                    // statusError
    let statusPending = Color(hex: 0x818188)                  // statusIdle
    let statusWaitingChildren = Color(hex: 0xFBBF24)          // statusWaitingChildren
    let statusBash = Color(hex: 0xFF2D95)                     // statusBash
    let statusWarning = Color(hex: 0xF59E0B)                  // statusWarning
    let surfaceElevated = Color(hex: 0x1E1E23)                // surfacePrimary
    let codeBg = Color(hex: 0x0E0E11)                         // codeBg
    let userBubbleTint = Color(hex: 0x1E1E23)                 // userBubble

    let preferredColorScheme: ColorScheme? = .dark
    let backgroundView: AnyView? = nil
    let activityIndicator: ((Bool) -> AnyView)? = nil
}

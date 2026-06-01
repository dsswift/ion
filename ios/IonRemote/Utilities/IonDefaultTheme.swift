import SwiftUI

// MARK: - IonDefaultTheme

/// The original Ion color palette. System-adaptive (light/dark follows iOS).
struct IonDefaultTheme: AppTheme {
    let id = "ion-default"
    let displayName = "Ion Default"

    let accent = Color(hex: 0x4ECDC4)
    let accentSubtle = Color(hex: 0x4ECDC4, opacity: 0.12)
    var accentGlow: Color { Color(hex: 0x4ECDC4).opacity(0.18) }
    var background: Color { Color(.systemBackground) }
    var textPrimary: Color { Color(.label) }
    var textSecondary: Color { Color(.secondaryLabel) }
    let statusRunning = Color(hex: 0xE8854A)
    let statusDone = Color.green
    let statusError = Color.red
    let statusPending = Color.orange
    let surfaceElevated = Color(.tertiarySystemBackground)
    let codeBg = Color(.secondarySystemFill).opacity(0.7)
    let userBubbleTint = Color(hex: 0x4ECDC4, opacity: 0.08)

    let preferredColorScheme: ColorScheme? = nil
    let backgroundView: AnyView? = nil
    let activityIndicator: ((Bool) -> AnyView)? = nil
}

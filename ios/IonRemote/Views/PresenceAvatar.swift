import SwiftUI

/// A small initial-circle avatar for FR-02 presence -- another connection
/// focused on (or driving) a tab. No existing avatar/initials view exists in
/// the codebase (see `EngineHarnessBadge.swift` for the closest precedent, a
/// pure abbreviation function with no current render site); this is
/// deliberately minimal rather than reusing that unrelated badge shape.
struct PresenceAvatar: View {
    @Environment(\.appTheme) private var theme
    let displayName: String
    var isDriving: Bool = false

    var body: some View {
        Circle()
            .fill(theme.accent.opacity(0.25))
            .overlay(
                Circle().strokeBorder(theme.accent.opacity(isDriving ? 1.0 : 0.4), lineWidth: 1)
            )
            .overlay(
                Text(initial)
                    .font(.system(size: 8, weight: .semibold)) // design-type: single-letter avatar glyph sized as icon geometry, not text
                    .foregroundStyle(theme.accent)
            )
            .frame(width: 14, height: 14)
            .accessibilityLabel(isDriving ? "\(displayName) is driving this tab" : "\(displayName) is viewing this tab")
    }

    private var initial: String {
        String(displayName.prefix(1)).uppercased()
    }
}

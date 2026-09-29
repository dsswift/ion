import SwiftUI

/// A small label beside a row's title: "admin", "this phone".
struct AccessChip: View {
    @Environment(\.appTheme) private var theme
    let text: String
    var prominent = false

    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, IonSpace.compactInset)
            .padding(.vertical, 2)
            .foregroundStyle(prominent ? theme.accent : theme.textSecondary)
            .background(Capsule().fill(prominent ? theme.accentSubtle : Color.secondary.opacity(0.12)))
    }
}

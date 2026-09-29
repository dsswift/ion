import SwiftUI

/// One provider in the list: its name, a status dot, and how it is signed in.
struct ProviderRow: View {
    let provider: ServerProviderEntry

    @Environment(\.appTheme) private var theme

    var body: some View {
        HStack(spacing: IonSpace.contentGap) {
            Circle()
                .fill(provider.hasAuth ? theme.statusDone : Color.secondary.opacity(0.4))
                .frame(width: 8, height: 8)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(provider.label)
                if provider.hasCustomGateway {
                    Text("Custom gateway").font(.caption).foregroundStyle(theme.statusWarning)
                }
            }
            Spacer(minLength: IonSpace.compactGap)
            Text(provider.statusLabel)
                .font(.callout)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .accessibilityElement(children: .combine)
    }
}

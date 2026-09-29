import SwiftUI

/// One paired device in a list: what it is, its marks, when it was last seen.
struct PairedClientRow: View {
    @Environment(\.appTheme) private var theme
    let paired: PairedClient
    let isOwn: Bool

    var body: some View {
        HStack(spacing: IonSpace.compactGap) {
            Image(systemName: paired.symbol)
                .font(.body)
                .foregroundStyle(theme.accent)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(paired.displayName)
                    .lineLimit(1)
                HStack(spacing: IonSpace.hairlineGap) {
                    if isOwn { AccessChip(text: "this phone", prominent: true) }
                    if paired.isAdmin { AccessChip(text: "admin") }
                    Text(paired.isConnected ? "Connected now" : "Seen \(paired.lastSeenDate.formatted(.relative(presentation: .named)))")
                        .font(.caption)
                        .foregroundStyle(theme.textSecondary)
                        .lineLimit(1)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

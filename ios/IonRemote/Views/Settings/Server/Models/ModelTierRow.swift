import SwiftUI

/// One tier in the list: its name, and its primary and first fallback model.
struct ModelTierRow: View {
    let tier: ModelTier

    @Environment(\.appTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: IonSpace.hairlineGap) {
                Text(tier.name)
                if tier.isBuiltIn {
                    Image(systemName: "checkmark.shield")
                        .font(.caption)
                        .foregroundStyle(theme.accent)
                        .accessibilityLabel("Built-in tier")
                }
            }
            Text(routeLine)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
        .accessibilityElement(children: .combine)
    }

    private var routeLine: String {
        guard !tier.model.isEmpty else {
            return tier.name == ModelTier.workbenchSync ? "Uses the standard tier" : "No primary model"
        }
        guard let fallback = tier.fallbacks.first else { return tier.model }
        return "\(tier.model) → \(fallback)"
    }
}

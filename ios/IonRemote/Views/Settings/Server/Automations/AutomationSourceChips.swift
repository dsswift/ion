import SwiftUI

/// Where an automation came from, and the layer that overrides it, if any.
struct AutomationSourceChips: View {
    let entry: AutomationSourceEntry

    var body: some View {
        HStack(spacing: IonSpace.hairlineGap) {
            chip(AutomationDescribe.sourceLabel(entry.source), tint: .secondary)
            if let overriddenBy = entry.overriddenBy {
                chip("Overridden by \(AutomationDescribe.sourceLabel(overriddenBy))", tint: .orange)
            }
        }
    }

    private func chip(_ text: String, tint: Color) -> some View {
        Text(text)
            .font(.caption2.weight(.medium))
            .foregroundStyle(tint)
            .padding(.horizontal, IonSpace.compactInset)
            .padding(.vertical, 2) // design-geometry: chip interior, matches the other admin chips
            .background(Capsule().fill(tint.opacity(0.12)))
    }
}

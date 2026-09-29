import SwiftUI

/// One labeled meter: the label, its value, and a thin static bar that turns
/// orange at 75% and red at 90%.
struct MetricMeter: View {
    let label: String
    let fraction: Double?
    let value: String

    @Environment(\.appTheme) private var theme

    var body: some View {
        let clamped = min(max(fraction ?? 0, 0), 1)
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.caption.weight(.medium)).lineLimit(1).minimumScaleFactor(0.8)
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color(.tertiarySystemFill))
                    Capsule().fill(tint(clamped)).frame(width: geo.size.width * clamped)
                }
            }
            .frame(height: 4)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private func tint(_ value: Double) -> Color {
        if value >= 0.9 { return .red }
        if value >= 0.75 { return .orange }
        return theme.accent
    }
}

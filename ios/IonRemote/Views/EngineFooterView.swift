import SwiftUI

/// Single-line status footer for engine tabs showing label, team, model, and context.
struct EngineFooterView: View {
    let fields: StatusFields

    var body: some View {
        HStack(spacing: 10) {
            // Label + state
            HStack(spacing: 4) {
                Text(fields.label)
                    .fontWeight(.medium)
                Text("[\(fields.state)]")
                    .foregroundStyle(.secondary)
            }

            Divider()
                .frame(height: 12)

            // Team
            Text(fields.team)
                .foregroundStyle(.secondary)

            Divider()
                .frame(height: 12)

            // Model
            Text(fields.model)
                .foregroundStyle(.tertiary)

            Spacer()

            // Context usage
            HStack(spacing: 4) {
                ProgressView(value: min(fields.contextPercent / 100.0, 1.0))
                    .frame(width: 40)
                    .tint(contextColor)
                Text("\(Int(fields.contextPercent))%")
                    .foregroundStyle(contextColor)
            }

            // Cost
            if let cost = fields.totalCostUsd {
                Text(String(format: "$%.2f", cost))
                    .foregroundStyle(.secondary)
            }
        }
        .font(.caption2)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(.ultraThinMaterial)
    }

    private var contextColor: Color {
        if fields.contextPercent > 90 { return .red }
        if fields.contextPercent > 75 { return .orange }
        return .secondary
    }
}

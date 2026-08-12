import SwiftUI

/// Quiet transcript metadata beneath a settled turn's tool-usage summary.
struct RunDurationRow: View {
    let durationMs: Int
    let reason: TaskCompletionReason?

    @Environment(\.appTheme) private var theme

    var body: some View {
        Text(label)
            .font(.caption2.monospacedDigit())
            .foregroundStyle(theme.textSecondary.opacity(0.65))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, 20) // design-geometry: transcript metadata aligns beneath tool summary chrome
            .padding(.top, 2) // design-geometry: compact caption baseline nudge
            .padding(.bottom, 3) // design-geometry: visual separation before next turn
            .accessibilityLabel(label)
    }

    var label: String {
        let duration = AgentDuration.formatMilliseconds(durationMs)
        switch reason {
        case .aborted:
            return "Stopped after \(duration)"
        case .some(.normal), .none:
            return "Completed in \(duration)"
        default:
            return "Ended after \(duration)"
        }
    }
}

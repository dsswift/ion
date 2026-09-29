import SwiftUI

/// One run: its outcome, the automation, what triggered it, and when it finished.
struct AutomationRunRow: View {
    let run: AutomationHistoryEntry
    let name: String

    var body: some View {
        HStack(alignment: .top, spacing: IonSpace.compactGap) {
            Image(systemName: Self.symbol(run.outcome))
                .foregroundStyle(Self.tint(run.outcome))
                .accessibilityLabel(run.outcome)
            VStack(alignment: .leading, spacing: IonSpace.hairlineGap) {
                Text(name)
                Text(AutomationDescribe.triggerLabel(run.eventType)).font(.caption).foregroundStyle(.secondary)
                if let finished = Self.date(run.finishedAt) {
                    Text(finished, format: .dateTime.month().day().hour().minute()).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    static func symbol(_ outcome: String) -> String {
        switch outcome {
        case "succeeded": return "checkmark.circle.fill"
        case "failed": return "xmark.octagon.fill"
        default: return "forward.fill"
        }
    }

    static func tint(_ outcome: String) -> Color {
        switch outcome {
        case "succeeded": return .green
        case "failed": return .red
        default: return .orange
        }
    }

    static func date(_ iso: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: iso) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: iso)
    }
}

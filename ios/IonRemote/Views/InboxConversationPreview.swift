import SwiftUI

/// The long-press preview shares durable Inbox facts across active, Snoozed, and
/// Settled rows. Values originate in the desktop snapshot; this view never
/// infers execution identity or worktree membership.
struct InboxConversationPreview: View {
    let tab: RemoteTabState
    let projectName: String
    let location: String?
    let branch: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(tab.displayTitle)
                .font(.headline)
                .lineLimit(2)
            detail("Project", projectName)
            if let location { detail("Location", location) }
            if let branch { detail("Branch", branch) }
            if let host = tab.executionHost { detail("Host", host) }
            if let machine = tab.executionMachineId { detail("Machine", machine) }
            if let activity = relativeTime(tab.lastActivityAt) { detail("Activity", activity) }
            if let settled = relativeTime(tab.settledAt) { detail("Settled", settled) }
            if let count = tab.messageCount { detail("Messages", String(count)) }
            if let turns = tab.conversationTurns { detail("Prompts", String(turns)) }
            if let duration = tab.lastRunDurationMs { detail("Last run", durationText(duration)) }
            if let cost = tab.runCostUsd { detail("Cost", String(format: "$%.4f", cost)) }
        }
        .padding()
    }

    private func detail(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).foregroundStyle(.secondary)
            Spacer(minLength: 12)
            Text(value).multilineTextAlignment(.trailing)
        }
        .font(.caption)
    }

    private func relativeTime(_ milliseconds: Double?) -> String? {
        guard let milliseconds, milliseconds > 0 else { return nil }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: Date(timeIntervalSince1970: milliseconds / 1000), relativeTo: Date())
    }

    private func durationText(_ milliseconds: Int) -> String {
        let seconds = Double(milliseconds) / 1_000
        return seconds >= 60 ? String(format: "%.1f min", seconds / 60) : String(format: "%.1f sec", seconds)
    }
}

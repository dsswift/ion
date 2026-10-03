import SwiftUI

/// The long-press preview shares durable Inbox facts across active, Snoozed, and
/// Settled rows. Values originate in the desktop snapshot; this view never
/// infers execution identity or worktree membership.
///
/// Laid out as a title over two groups, where it lives and what it has done,
/// each a label column beside a value column, so the eye reads down one edge
/// instead of across eleven rows of equal weight.
struct InboxConversationPreview: View {
    @Environment(\.appTheme) private var theme
    let tab: RemoteTabState
    let projectName: String
    let location: String?
    let branch: String?

    private var placeRows: [(String, String)] {
        var rows = [("Project", projectName)]
        if let location { rows.append(("Location", location)) }
        if let branch { rows.append(("Branch", branch)) }
        if let host = tab.executionHost { rows.append(("Host", host)) }
        if let machine = tab.executionMachineId { rows.append(("Machine", machine)) }
        return rows
    }

    private var activityRows: [(String, String)] {
        var rows: [(String, String)] = []
        if let activity = relativeTime(tab.lastActivityAt) { rows.append(("Activity", activity)) }
        if let settled = relativeTime(tab.settledAt) { rows.append(("Settled", settled)) }
        if let count = tab.messageCount { rows.append(("Messages", String(count))) }
        if let turns = tab.conversationTurns { rows.append(("Prompts", String(turns))) }
        if let duration = tab.lastRunDurationMs { rows.append(("Last run", durationText(duration))) }
        if let cost = tab.runCostUsd { rows.append(("Cost", String(format: "$%.4f", cost))) }
        return rows
    }

    var body: some View {
        VStack(alignment: .leading, spacing: IonSpace.contentGap) {
            Text(tab.displayTitle)
                .font(IonType.bodyStrong)
                .foregroundStyle(theme.textPrimary)
                .lineLimit(2)
            group(placeRows)
            if !activityRows.isEmpty {
                Rectangle()
                    .fill(theme.borderSubtle)
                    .frame(height: 1)
                group(activityRows)
            }
        }
        .padding(IonSpace.rowInset)
        .frame(width: 300, alignment: .leading)
        .background(theme.surfaceElevated)
    }

    private func group(_ rows: [(String, String)]) -> some View {
        Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: IonSpace.contentGap, verticalSpacing: IonSpace.hairlineGap) {
            ForEach(rows, id: \.0) { label, value in
                GridRow {
                    Text(label)
                        .font(IonType.metadata)
                        .foregroundStyle(theme.textTertiary)
                    Text(value)
                        .font(IonType.metadata)
                        .foregroundStyle(theme.textPrimary)
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
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

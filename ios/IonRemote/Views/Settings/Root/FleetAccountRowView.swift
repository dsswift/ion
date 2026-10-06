import SwiftUI

/// One account on the Fleet screen: who it is, each usage limit as a bar, and
/// the servers it is on. A solid server name is signed in now; a gray one was
/// seen there in the last 30 days. The email shows only when revealed.
struct FleetAccountRowView: View {
    let row: FleetAccountRow
    let revealEmail: Bool

    @Environment(\.appTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(row.title(revealEmail: revealEmail))
                    .foregroundStyle(row.signedIn ? .primary : .secondary)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text(Self.subtitle(row))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            if row.limits.isEmpty {
                Text("No usage read yet")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            ForEach(Array(row.limits.enumerated()), id: \.offset) { _, limit in
                limitRow(limit)
            }
            if let expiring = FleetSummary.expiring(row).first {
                Label(Self.expiringText(expiring), systemImage: "hourglass.bottomhalf.filled")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
            Text(machines)
                .font(.caption)
                .lineLimit(2)
        }
        .padding(.vertical, 2) // design-geometry: tight 2pt inset; below the 4pt rhythm floor
        .accessibilityElement(children: .combine)
    }

    private func limitRow(_ limit: FleetAccount.Limit) -> some View {
        let expired = FleetSummary.expired(limit)
        return VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(FleetSummary.title(limit))
                Spacer()
                Text(expired ? "Reset since last read" : Self.detail(limit))
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            ProgressView(value: expired ? 0 : min(max(limit.percent, 0), 100), total: 100)
                .tint(limit.percent >= 90 ? .red : limit.percent >= 70 ? .orange : theme.statusDone)
        }
    }

    private var machines: AttributedString {
        var text = AttributedString()
        for (index, machine) in row.machines.enumerated() {
            var part = AttributedString(machine.label)
            part.foregroundColor = machine.signedIn ? .primary : Color(.tertiaryLabel)
            text += part
            if index < row.machines.count - 1 {
                var gap = AttributedString("  ·  ")
                gap.foregroundColor = Color(.tertiaryLabel)
                text += gap
            }
        }
        return text
    }

    /// "Anthropic · max", or how long ago a signed-out account was last seen.
    static func subtitle(_ row: FleetAccountRow, now: Date = .now) -> String {
        var parts = [ServerProviderEntry.displayName(for: row.provider, in: [])]
        if let plan = row.planType, !plan.isEmpty { parts.append(plan) }
        if !row.signedIn {
            let seen = Date(timeIntervalSince1970: row.lastSeen / 1000)
            parts.append("seen \(seen.formatted(.relative(presentation: .named, unitsStyle: .abbreviated)))")
        }
        return parts.joined(separator: " · ")
    }

    /// "40% of the 7-day limit resets unused in 6 hr."
    static func expiringText(_ expiring: FleetExpiringQuota, now: Date = .now) -> String {
        let what = expiring.limit.kind == "weekly_model" ? "7-day \(expiring.limit.label ?? "model")" : "7-day"
        return "\(Int(expiring.unusedPercent.rounded()))% of the \(what) limit resets unused \(expiring.resetsAt.formatted(.relative(presentation: .numeric, unitsStyle: .abbreviated)))."
    }

    /// "42% · resets in 3 hr".
    static func detail(_ limit: FleetAccount.Limit, now: Date = .now) -> String {
        let percent = "\(Int(limit.percent.rounded()))%"
        guard let resets = FleetSummary.resetDate(limit), resets > now else { return percent }
        return "\(percent) · resets \(resets.formatted(.relative(presentation: .numeric, unitsStyle: .abbreviated)))"
    }
}

/// One provider's quota on the Fleet screen: each limit summed over its
/// accounts as a bar, with how much of the pool is used and how much is left.
struct FleetQuotaPoolView: View {
    let pool: FleetQuotaPool

    @Environment(\.appTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(ServerProviderEntry.displayName(for: pool.provider, in: []))
                Spacer(minLength: 8)
                Text(pool.accounts == 1 ? "1 account" : "\(pool.accounts) accounts")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            ForEach(Array(pool.limits.enumerated()), id: \.offset) { _, limit in
                let share = limit.capacity > 0 ? limit.used / limit.capacity * 100 : 0
                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text(FleetSummary.title(kind: limit.kind, label: limit.label))
                        Spacer()
                        Text(Self.detail(limit))
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    ProgressView(value: min(limit.used, limit.capacity), total: max(limit.capacity, 1))
                        .tint(share >= 90 ? .red : share >= 70 ? .orange : theme.statusDone)
                    if let resets = Self.resetsText(limit) {
                        Text(resets)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(.vertical, 2) // design-geometry: tight 2pt inset; below the 4pt rhythm floor
        .accessibilityElement(children: .combine)
    }

    /// "176% of 200% used · 24% left".
    static func detail(_ limit: FleetQuotaLimit) -> String {
        let used = Int(limit.used.rounded())
        return "\(used)% of \(Int(limit.capacity))% used · \(max(Int(limit.capacity) - used, 0))% left"
    }

    /// How many upcoming resets a limit lists.
    static let shownResets = 3

    /// "99% back in 9 hr · 42% back in 2 days": each account resets on its
    /// own clock, so each reset says only what it gives back. Nil when none is ahead.
    static func resetsText(_ limit: FleetQuotaLimit) -> String? {
        guard !limit.resets.isEmpty else { return nil }
        return limit.resets.prefix(shownResets)
            .map { "\(Int($0.freed.rounded()))% back \($0.at.formatted(.relative(presentation: .numeric, unitsStyle: .abbreviated)))" }
            .joined(separator: " · ")
    }
}

import SwiftUI

/// A single agent bar row: a compact status summary.
///
/// The row never expands in place — tapping it opens the full-screen detail
/// view, which is the single way to inspect a dispatch. Everything the row
/// renders therefore describes the agent's state right now, independent of what
/// the detail view has open.
struct AgentBarRow: View {
    let agent: AgentStateUpdate
    /// Every agent on the conversation, unfiltered. Feeds the descendant walk
    /// behind the status dots — a nested specialist is not in the visible row
    /// set but still determines whether its lead reads as waiting.
    let allAgents: [AgentStateUpdate]
    @Environment(\.appTheme) private var theme
    let onTap: (() -> Void)?
    @State private var now = Date()

    init(
        agent: AgentStateUpdate,
        allAgents: [AgentStateUpdate] = [],
        onTap: (() -> Void)? = nil
    ) {
        self.agent = agent
        self.allAgents = allAgents
        self.onTap = onTap
    }

    // Live elapsed seconds from startTime (running) or final elapsed (done).
    // Delegates to AgentDuration so the detail view can share the logic.
    //
    // The subject is the MOST RECENT dispatch — resolved by startTime, not
    // array position, because the engine merges dispatches in slot-insertion
    // order. This is the same subject the foreground status dot describes, so
    // the clock and the dot beside it never report different dispatches.
    private var elapsedSeconds: Int? {
        let latestDispatch = AgentDotResolver.mostRecentDispatch(agent.dispatches)
        let dispatchStatus = latestDispatch?.status ?? agent.status
        let dispatchStartTime = latestDispatch?.startTime ?? agent.startTime
        let dispatchElapsed = latestDispatch?.elapsed ?? agent.elapsed
        return AgentDuration.elapsedSeconds(
            status: dispatchStatus,
            startTime: dispatchStartTime,
            elapsed: dispatchElapsed,
            now: now
        )
    }

    var body: some View {
        headerRow
            .contentShape(Rectangle())
            .onTapGesture { onTap?() }
            .background(theme.surfaceElevated.opacity(0.5))
            .clipShape(RoundedRectangle(cornerRadius: IonRadius.control))
            .onReceive(Timer.publish(every: 1, on: .main, in: .common).autoconnect()) { t in
                if AgentDotResolver.isLiveStatus(agent.status) { now = t }
            }
    }

    // MARK: - Compact header (always visible)

    private var headerRow: some View {
        HStack(spacing: 6) {
            // Agent name pill — never wraps
            Text(agent.displayName)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.white)
                .lineLimit(1)
                .padding(.horizontal, IonSpace.compactGap)
                .padding(.vertical, 3) // design-geometry: 3pt inset; below the 4pt rhythm floor
                .background(agentColor.opacity(0.85))
                .clipShape(Capsule())
                .fixedSize()

            // Status dot(s). One dot when the agent has a single dispatch; two
            // overlapping dots when it has more, so a finished most-recent
            // dispatch cannot hide an older one still waiting on a live agent.
            switch AgentDotResolver.resolve(agent: agent, allAgents: allAgents, theme: theme) {
            case .single(let dot):
                Circle()
                    .fill(dot.color)
                    .frame(width: 6, height: 6)
                    .padding(.leading, 2) // design-geometry: tight 2pt inset; below the 4pt rhythm floor
            case .stack(let foreground, let background):
                AgentStatusDotStack(
                    foreground: foreground,
                    background: background,
                    ringColor: theme.surfaceElevated,
                    size: 6
                )
                .padding(.leading, 2) // design-geometry: tight 2pt inset; below the 4pt rhythm floor
            }

            // Live duration
            if let secs = elapsedSeconds {
                Text(AgentDuration.format(secs))
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(theme.statusIdle)
                    .fixedSize()
            }

            // Activity / last-work preview — fills remaining space
            if let activity = activityText, !activity.isEmpty {
                Text(activity)
                    .font(.caption2)
                    .foregroundStyle(theme.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }

            Spacer(minLength: 0)

            // Open-detail chevron. Static: the row never expands in place, so
            // this is an affordance for "this opens", not a state indicator.
            Image(systemName: "chevron.right")
                .font(.caption2)
                .foregroundStyle(theme.statusIdle)
        }
        .padding(.horizontal, 10) // design-geometry: 10pt gap between compactGap and contentGap; off the 4pt ratio scale
        .padding(.vertical, IonSpace.compactInset)
    }

    /// Text shown in the header activity area. For running agents this is
    /// the last tool or streaming snippet; for completed it's a short summary.
    private var activityText: String? {
        agent.lastWork
    }

    // MARK: - Helpers

    private var agentColor: Color {
        if let hex = agent.color { return Color(hex: hex) }
        switch agent.type {
        case "chief": return theme.statusRunning
        case "specialist": return theme.statusPending
        case "staff": return theme.statusStaff
        case "consultant": return theme.statusDone
        default: return theme.textSecondary
        }
    }
}

// MARK: - Color hex initializer

extension Color {
    init(hex: String) {
        let cleaned = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        var rgb: UInt64 = 0
        Scanner(string: cleaned).scanHexInt64(&rgb)
        let r = Double((rgb >> 16) & 0xFF) / 255
        let g = Double((rgb >> 8) & 0xFF) / 255
        let b = Double(rgb & 0xFF) / 255
        self.init(red: r, green: g, blue: b)
    }
}

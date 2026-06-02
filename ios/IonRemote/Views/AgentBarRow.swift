import SwiftUI

/// A single agent bar row: compact header + expandable conversation body.
struct AgentBarRow: View {
    let agent: AgentStateUpdate
    /// Legacy: messages looked up by agent name (single-dispatch agents).
    let messages: [Message]?
    /// Per-conversationId message cache for dispatch pager lookups.
    let convMessageCache: [String: [Message]]
    let isLoadingMessages: Bool
    let onExpand: (() -> Void)?
    /// Called with a single conversationId to load a specific dispatch.
    let onLoadDispatch: ((String) -> Void)?
    /// Called after the initial dispatch loads to preload the rest.
    let onPreloadDispatches: ((String) -> Void)?
    @Environment(\.appTheme) private var theme
    let onTap: (() -> Void)?
    @State private var isExpanded = false
    @State private var now = Date()

    init(
        agent: AgentStateUpdate,
        messages: [Message]? = nil,
        conversationMessages: [String: [Message]] = [:],
        isLoadingMessages: Bool,
        onExpand: (() -> Void)? = nil,
        onLoadDispatch: ((String) -> Void)? = nil,
        onPreloadDispatches: ((String) -> Void)? = nil,
        onTap: (() -> Void)? = nil
    ) {
        self.agent = agent
        self.messages = messages
        self.convMessageCache = conversationMessages
        self.isLoadingMessages = isLoadingMessages
        self.onExpand = onExpand
        self.onLoadDispatch = onLoadDispatch
        self.onPreloadDispatches = onPreloadDispatches
        self.onTap = onTap
    }

    // Live elapsed seconds from startTime (running) or final elapsed (done).
    private var elapsedSeconds: Int? {
        if agent.status == "running", let st = agent.startTime {
            let secs = Int(now.timeIntervalSince1970 - st)
            return max(0, secs)
        }
        if let e = agent.elapsed { return max(0, Int(e)) }
        return nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            headerRow
                .contentShape(Rectangle())
                .onTapGesture {
                    if let onTap {
                        onTap()
                        return
                    }
                    // If already expanded and loading, ignore tap to prevent
                    // the user from collapsing and restarting the same fetch.
                    if isExpanded && isLoadingMessages { return }
                    withAnimation(.snappy(duration: 0.15)) { isExpanded.toggle() }
                    if isExpanded {
                        onExpand?()
                        // Preload remaining dispatches after the initial expand
                        if let lastConvId = agent.dispatches.last?.conversationId, !lastConvId.isEmpty {
                            onPreloadDispatches?(lastConvId)
                        }
                    }
                }
            if isExpanded { expandedBody }
        }
        .background(theme.surfaceElevated.opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .onReceive(Timer.publish(every: 1, on: .main, in: .common).autoconnect()) { t in
            if agent.status == "running" { now = t }
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
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(agentColor.opacity(0.85))
                .clipShape(Capsule())
                .fixedSize()

            // Status dot
            Circle()
                .fill(statusColor)
                .frame(width: 6, height: 6)
                .padding(.leading, 2)

            // Live duration
            if let secs = elapsedSeconds {
                Text(formatDuration(secs))
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(theme.textSecondary.opacity(0.5))
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

            // Expand caret
            Image(systemName: "chevron.right")
                .font(.caption2)
                .foregroundStyle(theme.textSecondary.opacity(0.5))
                .rotationEffect(isExpanded ? .degrees(90) : .zero)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    /// Text shown in the header activity area. For running agents this is
    /// the last tool or streaming snippet; for completed it's a short summary.
    private var activityText: String? {
        agent.lastWork
    }

    // MARK: - Expanded body

    private var expandedBody: some View {
        VStack(alignment: .leading, spacing: 0) {
            Divider().padding(.horizontal, 8)

            ScrollView {
                AgentExpandedContent(
                    agent: agent,
                    messages: messages,
                    convMessageCache: convMessageCache,
                    isLoadingMessages: isLoadingMessages,
                    onLoadDispatch: onLoadDispatch,
                    onPreloadDispatches: onPreloadDispatches
                )
            }
            .frame(maxHeight: 240)
        }
    }

    // MARK: - Helpers

    private var agentColor: Color {
        if let hex = agent.color { return Color(hex: hex) }
        switch agent.type {
        case "chief": return theme.statusRunning
        case "specialist": return theme.statusPending
        case "staff": return .purple
        case "consultant": return theme.statusDone
        default: return theme.textSecondary
        }
    }

    private var statusColor: Color {
        switch agent.status {
        case "running": return theme.statusRunning
        case "done": return theme.statusDone
        case "error": return theme.statusError
        default: return theme.textSecondary.opacity(0.5)
        }
    }

    private func formatDuration(_ secs: Int) -> String {
        if secs < 60 { return "\(secs)s" }
        if secs < 3600 { return "\(secs / 60)m \(secs % 60)s" }
        let h = secs / 3600
        let m = (secs % 3600) / 60
        return "\(h)h \(m)m"
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

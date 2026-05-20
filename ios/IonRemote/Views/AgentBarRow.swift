import SwiftUI

/// A single agent bar row: compact header + expandable conversation body.
struct AgentBarRow: View {
    let agent: AgentStateUpdate
    @State private var isExpanded = false
    @State private var now = Date()

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
                    withAnimation(.snappy(duration: 0.15)) { isExpanded.toggle() }
                }
            if isExpanded { expandedBody }
        }
        .background(Color(.systemGray6).opacity(0.5))
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
                    .foregroundStyle(.tertiary)
                    .fixedSize()
            }

            // Activity / last-work preview — fills remaining space
            if let activity = activityText, !activity.isEmpty {
                Text(activity)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }

            Spacer(minLength: 0)

            // Expand caret
            Image(systemName: "chevron.right")
                .font(.caption2)
                .foregroundStyle(.tertiary)
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
                VStack(alignment: .leading, spacing: 6) {
                    // Model tag
                    if let model = agent.model, !model.isEmpty {
                        HStack(spacing: 4) {
                            Image(systemName: "cpu")
                                .font(.caption2)
                            Text(modelLabel(model))
                                .font(.caption2)
                        }
                        .foregroundStyle(.tertiary)
                        .padding(.horizontal, 12)
                    }

                    // Dispatch task (the orchestrator's instruction to the agent)
                    if let task = agent.task, !task.isEmpty {
                        dispatchBubble(task)
                    }

                    // Agent output — rendered as markdown
                    if let fullOutput = agent.fullOutput, !fullOutput.isEmpty {
                        MarkdownContentView(
                            blocks: MarkdownBlockCache.shared.blocks(for: fullOutput)
                        )
                        .textSelection(.enabled)
                        .padding(.horizontal, 12)
                    } else if agent.status == "running" {
                        HStack(spacing: 6) {
                            ProgressView().scaleEffect(0.6)
                            Text("Working…")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                        .padding(.horizontal, 12)
                    }
                }
                .padding(.vertical, 6)
            }
            .frame(maxHeight: 240)
        }
    }

    /// A visually distinct bubble for the orchestrator's dispatch instruction.
    private func dispatchBubble(_ task: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: "arrow.right.circle.fill")
                .font(.caption)
                .foregroundStyle(.orange.opacity(0.7))
                .padding(.top, 2)
            Text(task)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .padding(.horizontal, 10)
    }

    // MARK: - Helpers

    private var agentColor: Color {
        if let hex = agent.color { return Color(hex: hex) }
        switch agent.type {
        case "chief": return .orange
        case "specialist": return .blue
        case "staff": return .purple
        case "consultant": return .green
        default: return .gray
        }
    }

    private var statusColor: Color {
        switch agent.status {
        case "running": return .orange
        case "done": return .green
        case "error": return .red
        default: return .gray
        }
    }

    private func modelLabel(_ model: String) -> String {
        if model.contains("opus") { return "Opus" }
        if model.contains("sonnet") { return "Sonnet" }
        if model.contains("haiku") { return "Haiku" }
        return model
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

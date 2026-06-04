import SwiftUI

// MARK: - TabRowView

struct TabRowView: View {
    @Environment(\.appTheme) private var theme
    let tab: RemoteTabState
    var showDirectory: Bool = false
    var showGitInfo: Bool = false
    var idleSince: Date?
    var isSpeaking: Bool = false
    var gitChanges: GitChangesResponse? = nil
    var onOpenGit: (() -> Void)? = nil

    @State private var pulseOpacity: Double = 1.0

    var body: some View {
        let _ = DiagnosticLog.log("[TabRowView] rendering with accent: \(theme.accent), theme id: \(theme.id)")
        HStack(spacing: 12) {
            // Status indicator: show a custom SF Symbol icon when pillIcon is set,
            // otherwise fall back to the default Circle. Status dot color always
            // tracks the semantic status (running=orange, idle=gray, etc.) —
            // the pill color is expressed as a row background tint, not as a
            // dot color override. This matches the desktop model where pillColor
            // tints the pill background/border while the status dot remains semantic.
            pillIndicator(color: statusInfo.color)
                .opacity(statusInfo.pulse ? pulseOpacity : 1.0)
                .shadow(color: statusInfo.pulse ? statusInfo.color.opacity(0.6) : .clear, radius: 3)
                .onChange(of: statusInfo.pulse) { _, shouldPulse in
                    if shouldPulse {
                        withAnimation(.easeInOut(duration: 1.5).repeatForever(autoreverses: true)) {
                            pulseOpacity = 0.3
                        }
                    } else {
                        withAnimation(.default) {
                            pulseOpacity = 1.0
                        }
                    }
                }
                .onAppear {
                    if statusInfo.pulse {
                        withAnimation(.easeInOut(duration: 1.5).repeatForever(autoreverses: true)) {
                            pulseOpacity = 0.3
                        }
                    }
                }

            if tab.isEngine == true {
                Image(systemName: "bolt.fill")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if tab.isTerminalOnly == true {
                Image(systemName: "terminal")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if isSpeaking {
                Image(systemName: "speaker.wave.2.fill")
                    .font(.caption)
                    .foregroundStyle(theme.accent)
                    .symbolEffect(.variableColor.iterative)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(tab.displayTitle)
                    .font(.headline)

                if showDirectory || (showGitInfo && gitChanges?.isGitRepo == true) {
                    secondaryRow
                }

                if tab.status == .running || tab.status == .connecting {
                    Text("Running…")
                        .font(.caption2)
                        .foregroundStyle(theme.statusRunning)
                        .lineLimit(1)
                } else if let since = idleSince, tab.isTerminalOnly != true {
                    TimelineView(.periodic(from: .now, by: 60)) { context in
                        Text(idleLabel(at: context.date, since: since))
                            .font(.caption2)
                            .foregroundStyle(idleLabelColor)
                            .lineLimit(1)
                    }
                }

                if let message = tab.lastMessage {
                    Text(message)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
            }

            Spacer()

            if tab.groupPinned == true && tab.isEngine != true {
                Image(systemName: "pin.fill")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 4)
    }

    // MARK: - Secondary Row (directory • branch)

    @ViewBuilder
    private var secondaryRow: some View {
        HStack(spacing: 4) {
            // Directory segment
            if showDirectory {
                Image(systemName: "folder")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text(directoryLabel)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            // Separator between dir and git segment
            if showDirectory && showGitInfo, let git = gitChanges, git.isGitRepo {
                Text("•")
                    .font(.caption2)
                    .foregroundStyle(.quaternary)
            }

            // Git / branch segment — wrapped in a Button for tap-to-open-git
            if showGitInfo, let git = gitChanges, git.isGitRepo {
                Button {
                    onOpenGit?()
                } label: {
                    gitSegment(git)
                }
                .buttonStyle(.plain)
                .contentShape(Rectangle())
            }
        }
    }

    @ViewBuilder
    private func gitSegment(_ git: GitChangesResponse) -> some View {
        HStack(spacing: 3) {
            Image(systemName: "arrow.triangle.branch")
                .font(.caption2)
                .foregroundStyle(.secondary)

            if !git.branch.isEmpty {
                Text(git.branch)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }

            if git.ahead > 0 {
                HStack(spacing: 1) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 8, weight: .semibold))
                    Text("\(git.ahead)")
                        .font(.caption2.weight(.medium))
                }
                .foregroundStyle(.secondary)
                .fixedSize()
            }

            if git.behind > 0 {
                HStack(spacing: 1) {
                    Image(systemName: "arrow.down")
                        .font(.system(size: 8, weight: .semibold))
                    Text("\(git.behind)")
                        .font(.caption2.weight(.medium))
                }
                .foregroundStyle(.secondary)
                .fixedSize()
            }

            let changeCount = git.effectiveStagedCount + git.effectiveUnstagedCount
            if changeCount > 0 {
                HStack(spacing: 1) {
                    Circle()
                        .fill(Color.orange)
                        .frame(width: 5, height: 5)
                    Text("\(changeCount)")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.orange)
                }
                .fixedSize()
            }
        }
    }

    private var directoryLabel: String {
        let path = tab.workingDirectory
        let base = (path as NSString).lastPathComponent
        if base.isEmpty || path == "/" || path == "~" { return "Home" }
        return base
    }

    // MARK: - Idle Label

    private func idleLabel(at now: Date, since: Date) -> String {
        let elapsed = relativeTime(from: since, to: now)
        let hasPlanReady = tab.permissionQueue.contains { $0.toolName == "ExitPlanMode" }
        let hasQuestion = tab.permissionQueue.contains { $0.toolName == "AskUserQuestion" }

        if hasQuestion {
            return "Waiting on you · \(elapsed)"
        } else if hasPlanReady {
            return "Plan ready · \(elapsed)"
        } else if tab.status == .failed {
            return "Failed \(elapsed)"
        } else if tab.status == .dead {
            return "Dead \(elapsed)"
        } else if tab.status == .completed {
            return "Completed \(elapsed)"
        } else {
            return "Idle \(elapsed)"
        }
    }

    private var idleLabelColor: Color {
        let hasQuestion = tab.permissionQueue.contains { $0.toolName == "AskUserQuestion" }
        let hasPlanReady = tab.permissionQueue.contains { $0.toolName == "ExitPlanMode" }
        if hasQuestion { return Color(hex: 0x4A9EF5) }
        if hasPlanReady { return .green }
        if tab.status == .failed || tab.status == .dead { return Color(hex: 0xC47060) }
        return Color(hex: 0x8A8A80)
    }

    private func relativeTime(from start: Date, to end: Date) -> String {
        let seconds = Int(end.timeIntervalSince(start))
        if seconds < 60 { return "just now" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)m ago" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h ago" }
        let days = hours / 24
        return "\(days)d ago"
    }

    /// Resolve the custom pill color to a SwiftUI Color. Returns nil when
    /// `tab.pillColor` is nil or cannot be parsed as a hex string.
    /// Used by TabListView to apply listRowBackground on the cell.
    var pillColorValue: Color? {
        guard let hex = tab.pillColor, !hex.isEmpty else { return nil }
        return Color(hex: hex)
    }

    /// Render the status dot as an SF Symbol icon when `tab.pillIcon` is set,
    /// or as a plain Circle otherwise. Both are sized at 8×8 to match.
    @ViewBuilder
    private func pillIndicator(color: Color) -> some View {
        if let icon = tab.pillIcon, let sfSymbol = Self.pillIconToSFSymbol(icon) {
            Image(systemName: sfSymbol)
                .font(.system(size: 8, weight: .bold))
                .foregroundStyle(color)
                .frame(width: 8, height: 8)
        } else {
            Circle()
                .fill(color)
                .frame(width: 8, height: 8)
        }
    }

    /// Map a desktop pill icon key to the corresponding SF Symbol name.
    /// Returns nil for unknown keys (falls back to Circle).
    private static func pillIconToSFSymbol(_ icon: String) -> String? {
        switch icon {
        case "diamond":  return "diamond.fill"
        case "square":   return "square.fill"
        case "star":     return "star.fill"
        case "triangle": return "triangle.fill"
        case "heart":    return "heart.fill"
        case "hexagon":  return "hexagon.fill"
        case "lightning": return "bolt.fill"
        case "mobile":   return "iphone"
        case "desktop":  return "desktopcomputer"
        case "gear":     return "gearshape.fill"
        default:         return nil
        }
    }

    /// Status color and pulse state matching desktop TabStrip priority order.
    var statusInfo: (color: Color, pulse: Bool) {
        // 1. Dead/Failed -> Red (no pulse)
        if tab.status == .dead || tab.status == .failed {
            return (Color(hex: 0xC47060), false)
        }

        // 2. Check permission queue for special tool states
        let hasGenericPermission = tab.permissionQueue.contains {
            $0.toolName != "ExitPlanMode" && $0.toolName != "AskUserQuestion"
        }
        let hasPlanReady = tab.permissionQueue.contains { $0.toolName == "ExitPlanMode" }
        let hasQuestion = tab.permissionQueue.contains { $0.toolName == "AskUserQuestion" }

        // 3. Generic permission -> Orange (steady)
        if hasGenericPermission {
            return (Color(hex: 0xE8854A), false)
        }
        // 4. Running/Connecting -> Orange + pulse (before plan/question so active streaming always wins)
        if tab.status == .running || tab.status == .connecting {
            return (Color(hex: 0xE8854A), true)
        }
        // 5. Plan ready -> Green (idle or completed -- run finishes after auto-allow)
        if hasPlanReady && (tab.status == .idle || tab.status == .completed) {
            return (.green, false)
        }
        // 6. Question pending -> Blue (idle or completed)
        if hasQuestion && (tab.status == .idle || tab.status == .completed) {
            return (Color(hex: 0x4A9EF5), false)
        }
        // 7. Default -> Gray
        return (Color(hex: 0x8A8A80), false)
    }
}

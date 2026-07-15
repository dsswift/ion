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
    /// Engine profiles list, passed from the parent (TabListView reads it from
    /// the view model). Used to resolve the harness badge display name.
    var engineProfiles: [EngineProfile] = []

    @State private var pulseOpacity: Double = 1.0

    var body: some View {
        let _ = DiagnosticLog.trace("tab row rendering", tag: "view.tabrow", fields: [
            "reason": String(describing: theme.accent),
            "status": theme.id
        ])
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

            if tab.isTerminalOnly == true {
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

                if showDirectory || (showGitInfo && gitChanges?.isGitRepo == true) || tab.hasEngineExtension == true {
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

            if tab.groupPinned == true && tab.hasEngineExtension != true {
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
            // Harness badge — leading element when a harness/extension NAME is
            // present. #256 follow-up: gate on the DATA (a resolvable harness
            // label) rather than the `tab.hasEngineExtension` tab-type flag, so
            // the badge and its separators appear iff there is a name to show.
            if harnessBadgeLabel != nil {
                harnessBadge

                // Separator between badge and directory segment
                if showDirectory {
                    Text("•")
                        .font(.caption2)
                        .foregroundStyle(.quaternary)
                }

                // Separator between badge and git segment (when no directory is shown)
                if !showDirectory, showGitInfo, let git = gitChanges, git.isGitRepo {
                    Text("•")
                        .font(.caption2)
                        .foregroundStyle(.quaternary)
                }
            }

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

    // The subtitle text and color fold the SAME classifier the status dot uses
    // (`TabStatusRollup.classify`), keyed off its `priority`. This is what stops
    // the subtitle from diverging from the dot: previously the subtitle checked
    // plan-ready/question from `permissionQueue` FIRST and was blind to
    // `tab.hasRunningChildren`, so an idle tab with running children that still
    // carried an ExitPlanMode entry showed a yellow dot but a green
    // "Plan ready" subtitle. Now both surfaces read one decision.
    //
    // Only the running-children / plan-ready / question priorities are resolved
    // via the classifier here; the lower-priority failed/dead/completed/idle
    // outcomes fall through to the existing status-based cases. The running
    // (priority 6) branch never reaches here — the `tab.status == .running ||
    // .connecting` guard in `body` renders "Running…" before the idle branch.
    func idleLabel(at now: Date, since: Date) -> String {
        let elapsed = relativeTime(from: since, to: now)
        let priority = TabStatusRollup.classify(tab).priority

        switch priority {
        case TabStatusRollup.priorityChildren:
            return "Working… · \(elapsed)"
        case TabStatusRollup.priorityPlanReady:
            return "Plan ready · \(elapsed)"
        case TabStatusRollup.priorityQuestion:
            return "Waiting on you · \(elapsed)"
        default:
            if tab.status == .failed {
                return "Failed \(elapsed)"
            } else if tab.status == .dead {
                return "Dead \(elapsed)"
            } else if tab.status == .completed {
                return "Completed \(elapsed)"
            } else {
                return "Idle \(elapsed)"
            }
        }
    }

    var idleLabelColor: Color {
        let priority = TabStatusRollup.classify(tab).priority

        switch priority {
        case TabStatusRollup.priorityChildren:
            return TabStatusRollup.childrenYellow
        case TabStatusRollup.priorityPlanReady:
            return .green
        case TabStatusRollup.priorityQuestion:
            return TabStatusRollup.questionBlue
        default:
            if tab.status == .failed || tab.status == .dead { return Color(hex: 0xC47060) }
            return Color(hex: 0x8A8A80)
        }
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

    // MARK: - Harness badge

    /// Abbreviated profile name for the harness badge, or nil when the tab has
    /// no harness/extension NAME to show. Resolution order:
    ///   1. No `engineProfileId` on the tab → nil (badge hidden). This is the
    ///      DATA signal: a plain conversation carries no engine profile id, so
    ///      it has no harness name and shows no badge. An extension-backed tab
    ///      always carries one.
    ///   2. `engineProfileId` present → resolve against `engineProfiles`:
    ///      matched → abbreviated profile.name; unmatched (profile deleted or
    ///      profiles not yet synced) → "EXT".
    ///
    /// #256 follow-up: the gate is the PRESENCE OF THE PROFILE-ID DATA, not the
    /// `tab.hasEngineExtension` tab-type boolean. The two are equivalent today
    /// (the desktop sets `hasEngineExtension` iff `engineProfileId != nil`), but
    /// keying off the data keeps this branch-free of the tab-type flag in line
    /// with the "difference is data, never a tab-type fork" standard.
    private var harnessBadgeLabel: String? {
        guard let pid = tab.engineProfileId else { return nil }
        let profileName = engineProfiles.first(where: { $0.id == pid })?.name
        return abbreviateProfileName(profileName)
    }

    /// Accent-tinted text chip matching the desktop badge style spec:
    /// 9pt/semibold, accent bg at 15% opacity, accent border at 25% opacity,
    /// 4pt corner radius, no-wrap. Coexists with the status dot and pillIcon.
    @ViewBuilder
    private var harnessBadge: some View {
        if let label = harnessBadgeLabel {
            Text(label)
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(theme.accent)
                .padding(.horizontal, 3)
                .padding(.vertical, 1)
                .background(
                    RoundedRectangle(cornerRadius: 4)
                        .fill(theme.accent.opacity(0.15))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 4)
                        .strokeBorder(theme.accent.opacity(0.25), lineWidth: 0.5)
                )
                .fixedSize()
        }
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
    ///
    /// Delegates to the single shared classifier (`TabStatusRollup.classify`)
    /// so the per-tab dot and the group-header rollup dot fold the exact same
    /// cascade and cannot drift — mirroring how the desktop shares
    /// `getTabStatusColor` between the per-tab dot and `getGroupStatusColor`.
    var statusInfo: (color: Color, pulse: Bool) {
        let status = TabStatusRollup.classify(tab)
        return (status.color, status.shouldPulse)
    }
}

import SwiftUI

// MARK: - TabRowView

struct TabRowView: View {
    @Environment(\.appTheme) private var theme
    // Read from the environment rather than taken as a parameter: this view's
    // initializer is already at the point where adding another defaulted
    // argument breaks SwiftUI type inference at the call sites.
    @Environment(SessionViewModel.self) private var viewModel
    let tab: RemoteTabState
    var showDirectory: Bool = false
    var showGitInfo: Bool = false
    var idleSince: Date?
    var isSpeaking: Bool = false
    var gitChanges: GitChangesResponse? = nil
    var onOpenGit: (() -> Void)? = nil

    @State private var pulseOpacity: Double = 1.0

    var body: some View {
        let _ = DiagnosticLog.trace("tab row rendering", tag: "view.tabrow", fields: [
            "reason": String(describing: theme.accent),
            "status": theme.id
        ])
        HStack(spacing: IonSpace.contentGap) {
            // The status dot renders only when the tab is NOT idle. A dot on
            // every row carries no information in a list where most
            // conversations are quiet; suppressing the idle case is what makes
            // the remaining dots mean "look here". Every actionable state still
            // renders — error, permission, running, running-children,
            // background shells, plan-ready, question — so a failed background
            // agent is never indistinguishable from an idle conversation.
            //
            // The frame is reserved either way so titles stay aligned down a
            // mixed list rather than shifting by the dot's width.
            ZStack {
                if !isIdle {
                    pillIndicator(color: statusInfo.state.color(theme))
                        .opacity(statusInfo.state.breathes ? pulseOpacity : 1.0)
                        .shadow(color: statusInfo.state.breathes ? statusInfo.state.color(theme).opacity(0.6) : .clear, radius: 3)
                }
            }
            .frame(width: 8, height: 8)
            .onChange(of: statusInfo.state.breathes) { _, shouldPulse in
                if shouldPulse {
                    withAnimation(.easeInOut(duration: 1.5).repeatForever(autoreverses: true)) {
                        pulseOpacity = 0.35
                    }
                } else {
                    withAnimation(.default) {
                        pulseOpacity = 1.0
                    }
                }
            }
            .onAppear {
                if statusInfo.state.breathes {
                    withAnimation(.easeInOut(duration: 1.5).repeatForever(autoreverses: true)) {
                        pulseOpacity = 0.35
                    }
                }
            }

            if tab.isTerminalOnly == true {
                Image(systemName: "terminal")
                    .font(IonType.meaning)
                    .foregroundStyle(.secondary)
            }


            VStack(alignment: .leading, spacing: 2) {
                // `.body`, not `.headline`: a list of headline-weight titles
                // reads as a list of shouts.
                Text(tab.displayTitle)
.font(titleFont)
                    .lineLimit(1)

                // Exactly ONE subtitle line. Previously the metadata row, the
                // status line, and the message preview could all render at
                // once, stacking three lines of three different sizes under
                // the title. `subtitle(at:)` folds them into a single
                // precedence.
                //
                // Wrapped in a TimelineView because the status branch carries a
                // relative timestamp ("2h ago") that must keep counting; the
                // per-minute tick is what stops it freezing at its first
                // rendered value.
                TimelineView(.periodic(from: .now, by: 60)) { context in
                    if let subtitle = subtitle(at: context.date) {
                        Text(subtitle.text)
                            .font(IonType.meaning)
                            .foregroundStyle(subtitle.color)
                            .lineLimit(1)
                    }
                }
            }

            Spacer(minLength: 0)

            conditionRail
        }
        // Was 4. The row carries less content now, so it needs the padding to
        // keep a comfortable touch target instead of reading as cramped.
        .padding(.vertical, 10) // design-geometry: 10pt gap between compactGap and contentGap; off the 4pt ratio scale
    }

    // MARK: - Subtitle (single line, by precedence)

    /// Whether the tab folds to the idle status. Drives dot suppression and the
    /// subtitle precedence below — read from the one shared classifier so it can
    /// never disagree with the dot's own color.
    var isIdle: Bool {
        TabStatusRollup.classify(tab).priority == TabStatusRollup.priorityIdle
    }

    /// The single subtitle line, by precedence:
    ///
    ///   1. the live status label, whenever the tab is doing or awaiting
    ///      something ("Working… · 2h ago", "Plan ready · 5m ago") — this is the
    ///      actionable case and always outranks content;
    ///   2. the last message, which is the conversation preview;
    ///   3. the directory name, so a fresh conversation with no message still
    ///      says where it lives.
    ///
    /// Returns nil only when the tab is idle, has no message, and has no
    /// resolvable directory — in which case the row is title-only.
    ///
    /// `now` is passed in (rather than read as `Date()`) so the caller's
    /// TimelineView tick drives the relative timestamp and the function stays
    /// pure for tests.
    func subtitle(at now: Date) -> (text: String, color: Color)? {
        // 1. Running is its own label; every other non-idle state is described
        //    by `idleLabel`, which folds the same classifier as the dot.
        if tab.status == .running || tab.status == .connecting {
            return ("Running…", theme.statusRunning)
        }
        if !isIdle, let since = idleSince, tab.isTerminalOnly != true {
            return (idleLabel(at: now, since: since), idleLabelColor)
        }
        // 2. Conversation preview.
        if let message = tab.lastMessage, !message.isEmpty {
            return (message, theme.textTertiary)
        }
        // 3. Where it lives.
        let dir = directoryLabel
        if !dir.isEmpty {
            return (dir, theme.textTertiary)
        }
        return nil
    }

    // MARK: - Secondary Row (directory • branch)

    private var titleFont: Font {
        switch statusInfo.state {
        case .error, .permission, .planReady, .question: IonType.rowTitleAttention
        default: IonType.rowTitle
        }
    }

    private var worktree: RemoteWorktree? {
        viewModel.worktreeState(for: tab.workingDirectory)?.worktrees.first { $0.worktreePath == tab.workingDirectory }
    }

    private var conditionRailSymbols: [String] {
        var symbols: [String] = []
        if viewModel.isWorktreeBaseStale(tab.workingDirectory) { symbols.append("arrow.triangle.pull") }
        if worktree?.unlandedCommitCount ?? 0 > 0 { symbols.append("arrow.up.circle") }
        if worktree?.isDirty == true { symbols.append("circle.fill") }
        if isSpeaking { symbols.append("speaker.wave.2.fill") }
        return symbols
    }

    @ViewBuilder
    private var conditionRail: some View {
        let symbols = conditionRailSymbols
        HStack(spacing: IonSpace.hairlineGap) {
            ForEach(Array(symbols.prefix(2).enumerated()), id: \.offset) { _, symbol in
                Image(systemName: symbol)
                    .font(IonType.metadata)
            }
            if symbols.count > 2 {
                Text("+")
                    .font(IonType.microLabel)
            }
        }
        .foregroundStyle(theme.textTertiary)
        .accessibilityElement(children: .combine)
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
            return theme.statusWaitingChildren
        case TabStatusRollup.priorityPlanReady:
            return theme.statusDone
        case TabStatusRollup.priorityQuestion:
            return theme.statusQuestion
        default:
            if tab.status == .failed || tab.status == .dead { return theme.statusError }
            return theme.statusIdle
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

    /// Render the status dot as an SF Symbol icon when `tab.pillIcon` is set,
    /// or as a plain Circle otherwise. Both are sized at 8×8 to match.
    @ViewBuilder
    private func pillIndicator(color: Color) -> some View {
        if let icon = tab.pillIcon, let sfSymbol = Self.pillIconToSFSymbol(icon) {
            Image(systemName: sfSymbol)
                .font(.system(size: 8, weight: .bold)) // design-type: SF Symbol pill glyph sized as icon geometry, not text
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
    var statusInfo: GroupTabStatus {
        let status = TabStatusRollup.classify(tab)
        return status
    }
}

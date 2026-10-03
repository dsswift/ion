import SwiftUI

// MARK: - InboxRowView

/// One conversation row in the Inbox view: the title over a single detail
/// line, and a trailing status pill (Approval / Input / Working / Done /
/// Failed) or quiet relative age. Read+idle rows recede (inbox-zero).
///
/// PARITY: renders the desktop-derived fields only (`inboxState`, `unread`,
/// `wokeAt` arrive in the snapshot) — no Swift classifier. Status pill
/// precedence mirrors the desktop InboxRow (blocked-on-you first, then
/// working, then failure), resolved through the same TabStatusRollup
/// cascade the group rollups use, so the two can't disagree about what a
/// conversation is doing.
struct InboxRowView: View {
    @Environment(\.appTheme) private var theme
    @Environment(SessionViewModel.self) private var viewModel
    let tab: RemoteTabState
    /// Whether the detail line names the project. True in a flat list
    /// (Settled, history), where nothing else says where the conversation
    /// lives. False inside the filing tree, where the row already sits under
    /// its project header and the line is better spent on the last message.
    var showsProject: Bool = true

    enum Pill: Equatable {
        case approval, input, connecting, working, done, failed
    }

    /// Pill from the SAME rollup the status dots use (cascade priorities
    /// pinned by status-cascade.json + StatusCascadeParityTests).
    static func pill(for tab: RemoteTabState) -> Pill? {
        switch TabStatusRollup.classify(tab).state {
        case .permission: return .approval
        case .planReady, .question: return .input
        case .running, .children, .bash: return .working
        case .starting: return .connecting
        case .error: return .failed
        case .unread: return .done
        case .idle: return nil
        }
    }

    /// The single detail line under the title, or nil for a title-only row.
    enum Detail: Equatable {
        case project(String, autoSettled: Bool)
        case preview(String)
    }

    static func detail(for tab: RemoteTabState, showsProject: Bool) -> Detail? {
        if showsProject {
            let dir = tab.workingDirectory
            guard dir != "~", !dir.isEmpty, let name = dir.split(separator: "/").last else { return nil }
            return .project(String(name), autoSettled: tab.settledOverride == "auto")
        }
        let message = plainPreview(tab.lastMessage ?? "")
        return message.isEmpty ? nil : .preview(message)
    }

    /// The last message as one line of plain words. The message is markdown,
    /// and a one-line preview that opens with `**What was wrong?**` spends its
    /// few characters on markup: emphasis marks, code ticks, heading hashes,
    /// list bullets, and quote marks are dropped, and line breaks collapse.
    static func plainPreview(_ raw: String) -> String {
        var text = raw
        for pattern in [#"```[a-zA-Z0-9]*"#, #"\*{1,3}"#, #"_{2,3}"#, #"`"#, #"(?m)^\s{0,3}#{1,6}\s+"#, #"(?m)^\s{0,3}>\s?"#, #"(?m)^\s*[-*+]\s+"#] {
            text = text.replacingOccurrences(of: pattern, with: "", options: .regularExpression)
        }
        text = text.replacingOccurrences(of: #"\[([^\]]+)\]\([^)]+\)"#, with: "$1", options: .regularExpression)
        text = text.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        return text.trimmingCharacters(in: .whitespaces)
    }

    private var pill: Pill? { Self.pill(for: tab) }
    private var unread: Bool { tab.unread ?? false }
    private var woke: Bool { tab.wokeAt != nil }
    private var quiet: Bool { !unread && pill == nil }
    private var backgroundLabel: String? {
        tab.backgroundLiveness == "monitoring" ? "Monitoring" : nil
    }

    private var relativeAge: String? {
        guard let ts = tab.lastActivityAt, ts > 0 else { return nil }
        let date = Date(timeIntervalSince1970: ts / 1000)
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }

    var body: some View {
        HStack(spacing: IonSpace.contentGap) {
            VStack(alignment: .leading, spacing: 2) { // design-geometry: 2pt title-to-detail gap inside a two-line row; below the 4pt rhythm floor
                Text(tab.customTitle ?? tab.title)
                    .font(unread ? IonType.bodyStrong : IonType.body)
                    .foregroundStyle(quiet ? theme.textSecondary : theme.textPrimary)
                    .lineLimit(1)
                detailLine
            }
            Spacer(minLength: IonSpace.hairlineGap)
            trailingCluster
        }
        .padding(.vertical, IonSpace.hairlineGap)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var detailLine: some View {
        switch Self.detail(for: tab, showsProject: showsProject) {
        case .project(let name, let autoSettled):
            HStack(spacing: IonSpace.compactInset) {
                Text(name)
                if autoSettled {
                    Text("· Auto")
                        .accessibilityLabel("Automatically settled")
                }
            }
            .font(IonType.metadata)
            .foregroundStyle(theme.textTertiary)
            .lineLimit(1)
        case .preview(let message):
            Text(message)
                .font(IonType.metadata)
                .foregroundStyle(theme.textTertiary)
                .lineLimit(1)
        case nil:
            EmptyView()
        }
    }

    /// Trailing marks, in a fixed order so the same fact is always in the same
    /// place: what you can open (the terminal application), what is attached
    /// (a running terminal), whether it is pinned, what changed (woke), then
    /// the state itself.
    private var trailingCluster: some View {
        HStack(spacing: IonSpace.compactGap) {
            if let application = tab.resolvedTerminalApplications.first {
                Button {
                    viewModel.openTerminalApplication(tabId: tab.id, url: application.url)
                } label: {
                    Image(systemName: "globe")
                        .font(IonType.metadata)
                        .foregroundStyle(theme.statusBash)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Open \(application.url)")
            }
            if tab.hasRunningTerminal == true {
                Image(systemName: "terminal")
                    .font(IonType.metadata)
                    .foregroundStyle(theme.statusBash)
                    .accessibilityLabel("Terminal running")
            }
            if tab.pinnedAt != nil {
                Image(systemName: "pin.fill")
                    .font(IonType.microLabel)
                    .foregroundStyle(theme.textTertiary)
                    .accessibilityLabel("Pinned")
            }
            if woke {
                capsule("Woke", color: theme.accent)
            }
            if let pill {
                pillView(pill)
            } else if let backgroundLabel {
                Text(backgroundLabel)
                    .font(IonType.microLabel)
                    .foregroundStyle(theme.statusRunning)
            } else if let age = relativeAge {
                Text(age)
                    .font(IonType.metadata)
                    .foregroundStyle(theme.textTertiary)
            }
        }
    }

    private func pillView(_ pill: Pill) -> some View {
        let (label, color): (String, Color) = {
            switch pill {
            case .approval: return ("Approval", theme.statusWarning)
            case .input: return ("Input", theme.accent)
            case .connecting: return ("Connecting", theme.statusIdle)
            case .working: return ("Working", theme.statusRunning)
            case .done: return ("Done", theme.statusDone)
            case .failed: return ("Failed", theme.statusError)
            }
        }()
        return capsule(label, color: color)
    }

    private func capsule(_ label: String, color: Color) -> some View {
        Text(label)
            .font(IonType.microLabel)
            .padding(.horizontal, IonSpace.compactInset)
            .padding(.vertical, 2) // design-geometry: 2pt inset; keeps the status capsule on the row's single-line rhythm
            .background(color.opacity(0.15), in: Capsule())
            .foregroundStyle(color)
    }
}

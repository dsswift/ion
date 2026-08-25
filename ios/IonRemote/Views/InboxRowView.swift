import SwiftUI

// MARK: - InboxRowView

/// One conversation row in the Inbox view: title + project chip/branch,
/// and a trailing status pill (Approval / Input / Working / Done / Failed) or
/// quiet relative age. Read+idle rows recede (inbox-zero).
///
/// PARITY: renders the desktop-derived fields only (`inboxState`, `unread`,
/// `wokeAt` arrive in the snapshot) — no Swift classifier. Status pill
/// precedence mirrors the desktop InboxRow (blocked-on-you first, then
/// working, then failure), resolved through the same TabStatusRollup
/// cascade the classic rows use, so the two views can't disagree about
/// what a conversation is doing.
struct InboxRowView: View {
    @Environment(\.appTheme) private var theme
    @Environment(SessionViewModel.self) private var viewModel
    let tab: RemoteTabState

    private enum Pill {
        case approval, input, connecting, working, done, failed
    }

    /// Pill from the SAME rollup the classic status dot uses (cascade
    /// priorities pinned by status-cascade.json + StatusCascadeParityTests).
    private var pill: Pill? {
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

    private var unread: Bool { tab.unread ?? false }
    private var woke: Bool { tab.wokeAt != nil }
    private var quiet: Bool { !unread && pill == nil }
    private var isSlim: Bool { tab.inboxState == "snoozed" || tab.inboxState == "settled" }
    private var backgroundLabel: String? {
        tab.backgroundLiveness == "monitoring" ? "Monitoring" : nil
    }
    private var autoSettled: Bool { tab.settledOverride == "auto" }

    private var projectName: String? {
        let dir = tab.workingDirectory
        guard dir != "~", !dir.isEmpty else { return nil }
        return dir.split(separator: "/").last.map(String.init)
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
            VStack(alignment: .leading, spacing: 2) {
                Text(tab.customTitle ?? tab.title)
                    .font(.subheadline.weight(unread ? .semibold : .regular))
                    .foregroundStyle(theme.textPrimary)
                    .lineLimit(1)
                HStack(spacing: 4) {
                    if let project = projectName {
                        Text(project)
                            .font(.caption2)
                            .padding(.horizontal, IonSpace.hairlineGap)
                            .padding(.vertical, 1) // design-geometry: 1pt inset; a micro-tag reads as a tag only when it hugs its text
                            .background(theme.surfaceSecondary, in: RoundedRectangle(cornerRadius: 3)) // design-geometry: 3pt sub-control radius on a caption2 micro-tag; IonRadius.control would swallow the 1pt vertical inset
                            .foregroundStyle(theme.textSecondary)
                    }
                    if autoSettled {
                        Text("Auto")
                            .font(.caption2)
                            .foregroundStyle(theme.textSecondary)
                            .accessibilityLabel("Automatically settled")
                    }
                }
            }
            Spacer(minLength: 4)
            if tab.hasRunningTerminal == true {
                HStack(spacing: 2) {
                    Image(systemName: "terminal")
                        .font(.caption2)
                    Text("Terminal")
                        .font(.caption2.weight(.semibold))
                }
                .foregroundStyle(theme.statusBash)
                .accessibilityLabel("Terminal running")
            }
            if let application = tab.resolvedTerminalApplications.first {
                Button {
                    viewModel.openTerminalApplication(tabId: tab.id, url: application.url)
                } label: {
                    Image(systemName: "globe")
                        .font(.caption)
                        .foregroundStyle(theme.statusBash)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Open \(application.url)")
            }
            if woke {
                Text("Woke")
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 5) // design-geometry: 5pt capsule inset between hairlineGap and compactInset; off the 4pt ratio scale
                    .padding(.vertical, 1) // design-geometry: 1pt inset; keeps the woke capsule on the row's single-line rhythm
                    .background(theme.accent.opacity(0.15), in: Capsule())
                    .foregroundStyle(theme.accent)
            }
            if let pill {
                pillView(pill)
            } else if let backgroundLabel {
                Text(backgroundLabel)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(theme.statusRunning)
            } else if let age = relativeAge {
                Text(age)
                    .font(.caption2)
                    .foregroundStyle(theme.textSecondary)
            }
        }
        .opacity(quiet ? 0.6 : 1.0)
        .scaleEffect(isSlim ? 0.96 : 1.0, anchor: .leading)
    }

    @ViewBuilder
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
        Text(label)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, IonSpace.compactInset)
            .padding(.vertical, 1) // design-geometry: 1pt inset; keeps the status capsule on the row's single-line rhythm
            .background(color.opacity(0.15), in: Capsule())
            .foregroundStyle(color)
    }
}

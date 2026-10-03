import SwiftUI

/// What a project's conversations add up to, shown on the trailing edge of
/// its header: how many are waiting on the operator, how many failed, and how
/// many are working. A collapsed project still says whether it needs a look,
/// and a busy list can be scanned by header alone.
///
/// Counted from the same per-conversation pill the rows draw, so a header can
/// never claim a state none of its rows show.
struct InboxProjectRollup: View {
    @Environment(\.appTheme) private var theme
    let counts: Counts

    struct Counts: Equatable {
        var needsYou = 0
        var failed = 0
        var working = 0

        var isEmpty: Bool { needsYou == 0 && failed == 0 && working == 0 }
    }

    static func counts(for tabs: [RemoteTabState]) -> Counts {
        var counts = Counts()
        for tab in tabs where tab.isTerminalOnly != true {
            switch InboxRowView.pill(for: tab) {
            case .approval, .input: counts.needsYou += 1
            case .failed: counts.failed += 1
            case .working, .connecting: counts.working += 1
            case .done, nil: break
            }
        }
        return counts
    }

    var body: some View {
        HStack(spacing: IonSpace.hairlineGap) {
            // The same colours the rows use: a row waiting on the operator
            // wears the accent, so the count of them does too.
            mark(counts.needsYou, color: theme.accent, label: Self.label(.needsYou, counts.needsYou))
            mark(counts.failed, color: theme.statusError, label: Self.label(.failed, counts.failed))
            mark(counts.working, color: theme.statusRunning, label: Self.label(.working, counts.working))
        }
    }

    enum Mark { case needsYou, failed, working }

    /// The chip's words. A bare number beside a dot left the reader to guess
    /// what was being counted, so every chip says it.
    static func label(_ mark: Mark, _ count: Int) -> String {
        switch mark {
        case .needsYou: return "\(count) waiting on you"
        case .failed: return "\(count) failed"
        case .working: return "\(count) working"
        }
    }

    @ViewBuilder
    private func mark(_ count: Int, color: Color, label: String) -> some View {
        if count > 0 {
            Text(label)
                .font(IonType.microLabel)
                .foregroundStyle(color)
                .lineLimit(1)
                .padding(.horizontal, IonSpace.compactInset)
                .padding(.vertical, 2) // design-geometry: 2pt inset; matches the row status capsule's height
                .background(color.opacity(0.15), in: Capsule())
        }
    }
}

import SwiftUI

/// The dedicated terminal occupant for an integration bench.
///
/// A terminal has no conversation lifecycle, so this row exposes only terminal
/// navigation, durable Inbox pin state, and close. It never offers snooze,
/// settle, unread, rename, or conversation deletion.
struct InboxBenchTerminalRow: View {
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.appTheme) private var theme
    let tab: RemoteTabState

    var body: some View {
        Button {
            viewModel.navigateToTab(tab.id)
        } label: {
            // The same shape as a conversation row beside it: a title over
            // one detail line, with its mark on the trailing edge. A terminal
            // drawn as a thin one-line label under the same header did not
            // read as something to open.
            HStack(spacing: IonSpace.contentGap) {
                VStack(alignment: .leading, spacing: 2) { // design-geometry: 2pt title-to-detail gap inside a two-line row; below the 4pt rhythm floor
                    Text(tab.displayTitle)
                        .font(IonType.body)
                        .foregroundStyle(theme.textPrimary)
                        .lineLimit(1)
                    Text("Bench terminal")
                        .font(IonType.metadata)
                        .foregroundStyle(theme.textTertiary)
                        .lineLimit(1)
                }
                Spacer(minLength: IonSpace.hairlineGap)
                if tab.pinnedAt != nil {
                    Image(systemName: "pin.fill")
                        .font(IonType.microLabel)
                        .foregroundStyle(theme.textTertiary)
                        .accessibilityLabel("Pinned")
                }
                // Pink means a terminal is running, here as on every other
                // row. An idle bench terminal keeps the glyph, quietly.
                Image(systemName: "terminal")
                    .font(IonType.metadata)
                    .foregroundStyle(tab.hasRunningTerminal == true ? theme.statusBash : theme.textTertiary)
                    .accessibilityLabel(tab.hasRunningTerminal == true ? "Terminal running" : "Terminal")
            }
            .padding(.vertical, IonSpace.hairlineGap)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Go to bench terminal")
        .contextMenu {
            Button(tab.pinnedAt == nil ? "Pin Terminal" : "Unpin Terminal") {
                if tab.pinnedAt == nil {
                    viewModel.pinTab(tabId: tab.id)
                } else {
                    viewModel.unpinTab(tabId: tab.id)
                }
            }
            Button("Close Terminal", role: .destructive) {
                viewModel.closeTab(tab.id)
            }
        }
        .swipeActions(edge: .leading, allowsFullSwipe: false) {
            Button(tab.pinnedAt == nil ? "Pin" : "Unpin") {
                if tab.pinnedAt == nil {
                    viewModel.pinTab(tabId: tab.id)
                } else {
                    viewModel.unpinTab(tabId: tab.id)
                }
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button("Close", role: .destructive) {
                viewModel.closeTab(tab.id)
            }
        }
    }
}

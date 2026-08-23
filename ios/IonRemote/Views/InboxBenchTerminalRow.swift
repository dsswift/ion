import SwiftUI

/// The dedicated terminal occupant for an integration bench.
///
/// A terminal has no conversation lifecycle, so this row exposes only terminal
/// navigation, durable Inbox pin state, and close. It never offers snooze,
/// settle, unread, rename, or conversation deletion.
struct InboxBenchTerminalRow: View {
    @Environment(SessionViewModel.self) private var viewModel
    let tab: RemoteTabState

    var body: some View {
        Button {
            viewModel.navigateToTab(tab.id)
        } label: {
            HStack(spacing: IonSpace.contentGap) {
                if tab.pinnedAt != nil {
                    Image(systemName: "pin.fill")
                        .foregroundStyle(.secondary)
                        .accessibilityLabel("Pinned")
                }
                Image(systemName: "terminal")
                Text(tab.displayTitle)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .font(.caption)
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

import SwiftUI

// TabListView detail/destination and shared-component view builders extracted
// to keep TabListView.swift under the Swift 600-line cap (see ios/AGENTS.md →
// file-architecture rules). Moved verbatim from TabListView. The `@State` and
// `@Environment` properties they read (theme, selectedTabId, showNewTab) are
// declared internal (not private) on TabListView so this same-module extension
// can reach them, matching the TabListView+Helpers extraction pattern.
extension TabListView {

    // MARK: - Detail / Destination

    @ViewBuilder
    func destinationView(for tabId: String) -> some View {
        if viewModel.tab(for: tabId)?.isTerminalOnly == true {
            RemoteTerminalView(tabId: tabId)
        } else {
            // One unified conversation view for every non-terminal tab — plain
            // or extension (#256). Engine-only chrome self-gates on
            // `tabHasExtensions` inside the view.
            ConversationView(tabId: tabId)
        }
    }

    @ViewBuilder
    var detailView: some View {
        if let tabId = selectedTabId, viewModel.tab(for: tabId) != nil {
            destinationView(for: tabId)
                .id(tabId)
        } else {
            VStack(spacing: 12) {
                Image(systemName: "sidebar.leading")
                    .font(.system(size: 40))
                    .foregroundStyle(.tertiary)
                Text("Select a tab")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text("Choose a conversation from the sidebar.")
                    .font(.subheadline)
                    .foregroundStyle(.tertiary)
            }
        }
    }

    // MARK: - Shared Components

    var newTabButton: some View {
        Button {
            if allDirectories.isEmpty {
                // No directories known yet: route immediately (will create plain).
                requestNewConversation(directory: nil, pinToGroupId: nil)
            } else {
                showNewTab = true
            }
        } label: {
            Image(systemName: "plus")
        }
        .contextMenu {
            if let defaultDir = allDirectories.first {
                Button { requestNewConversation(directory: defaultDir.fullPath, pinToGroupId: nil) } label: {
                    Label("New Tab", systemImage: "plus")
                }
                Button { viewModel.createTerminalTab(workingDirectory: defaultDir.fullPath) } label: {
                    Label("New Terminal", systemImage: "terminal")
                }
            }
        }
    }

    @ViewBuilder
    var emptyStateOverlay: some View {
        if viewModel.tabs.isEmpty {
            VStack(spacing: 12) {
                Image(systemName: "terminal")
                    .font(.system(size: 40))
                    .foregroundStyle(theme.accent)
                Text("No Tabs")
                    .font(.title3.weight(.semibold))
                Text("Tap + to create a new tab or pull to refresh.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            .padding()
        }
    }

    @ViewBuilder
    var searchEmptyStateOverlay: some View {
        let isSearching = !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if isSearching && filteredDisplayGroups.isEmpty && !viewModel.tabs.isEmpty {
            VStack(spacing: 12) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 40))
                    .foregroundStyle(.tertiary)
                Text("No Results")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text("No tabs match \"\(searchText.trimmingCharacters(in: .whitespacesAndNewlines))\".")
                    .font(.subheadline)
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
            }
            .padding()
        }
    }
}

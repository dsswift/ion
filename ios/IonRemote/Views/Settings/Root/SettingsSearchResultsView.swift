import SwiftUI

/// Settings search results: each match opens the page it lives on.
struct SettingsSearchResultsView: View {
    let results: [SettingsSearchResult]

    @Environment(SessionViewModel.self) private var viewModel

    var body: some View {
        if results.isEmpty {
            Section {
                Text("No settings match.")
                    .foregroundStyle(.secondary)
            }
        } else {
            Section {
                ForEach(results) { result in
                    NavigationLink {
                        destination(result.destination)
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(result.title)
                            Text(result.detail)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func destination(_ destination: SettingsSearchResult.Destination) -> some View {
        switch destination {
        case .phone(let page):
            PhoneSettingsDestination(page: page)
        case .server(let pageId):
            if let device = viewModel.activeDevice,
               let session = viewModel.adminSession(for: device),
               let page = viewModel.serverSettings?.pages.first(where: { $0.id == pageId }) {
                ServerPageView(session: session, page: page)
            } else {
                ContentUnavailableView(
                    "Server not reachable",
                    systemImage: "bolt.horizontal.circle",
                    description: Text("Connect to the server again to open this page.")
                )
            }
        }
    }
}

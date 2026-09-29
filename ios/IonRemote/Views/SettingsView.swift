import SwiftUI

/// The root of Settings, in three groups:
///
/// - This iPhone: what this phone keeps for itself (Appearance, Behavior,
///   Voice, Notifications, Diagnostics & About).
/// - You: what follows you to every server (Defaults).
/// - Servers: every paired server, each opening its settings pages, which
///   server this phone chats on, and adding another.
///
/// Search matches page, section, and setting names across the phone's own
/// pages and the connected server's.
struct SettingsView: View {
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.appTheme) private var theme
    @Environment(\.dismiss) private var dismiss

    @State private var query = ""
    /// Bumped to rebuild the navigation stack at its root.
    @State private var stackGeneration = 0

    var body: some View {
        NavigationStack {
            List {
                if query.trimmingCharacters(in: .whitespaces).isEmpty {
                    pagesSection(.thisPhone, header: "This iPhone")
                    pagesSection(.you, header: "You")
                    SettingsServersSection()
                } else {
                    SettingsSearchResultsView(results: SettingsSearchIndex.results(
                        for: query,
                        state: viewModel.serverSettings,
                        serverLabel: viewModel.activeDevice?.displayName
                    ))
                }
            }
            .searchable(text: $query, prompt: "Search settings")
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .id(stackGeneration)
        .environment(\.settingsNavigation, SettingsNavigation(popToRoot: {
            DiagnosticLog.log("settings returned to root", tag: "view.settings")
            stackGeneration += 1
        }))
    }

    private func pagesSection(_ heading: PhoneSettingsPage.Heading, header: String) -> some View {
        Section(header) {
            ForEach(PhoneSettingsPage.allCases.filter { $0.heading == heading }) { page in
                NavigationLink {
                    PhoneSettingsDestination(page: page)
                } label: {
                    SettingsCategoryLabel(title: page.title, symbol: page.symbol, tint: page.tint(in: theme), detail: detail(for: page))
                }
            }
        }
    }

    private func detail(for page: PhoneSettingsPage) -> String? {
        switch page {
        case .appearance: return theme.displayName
        case .voice: return viewModel.voiceService.isEnabled ? "On" : "Off"
        case .behavior, .notifications, .diagnostics, .defaults: return nil
        }
    }
}

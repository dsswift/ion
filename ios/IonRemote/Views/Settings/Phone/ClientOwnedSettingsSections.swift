import SwiftUI

/// The projected sections of one phone page, or why there are none.
struct ClientOwnedSettingsSections: View {
    let page: PhoneSettingsPage

    @Environment(SessionViewModel.self) private var viewModel

    var body: some View {
        if let state = viewModel.serverSettings, let pageId = page.schemaPageId {
            let groups = ClientOwnedPageContent.groups(in: state, pageId: pageId)
            if groups.isEmpty {
                Section {
                    Text("The connected server does not describe any of these settings. Update it to change them here.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            } else {
                ForEach(groups) { group in
                    Section {
                        ForEach(group.keys, id: \.self) { key in
                            if let entry = state.schema.first(where: { $0.key == key }) {
                                ProjectedSettingRow(entry: entry, state: state)
                                    .disabled(state.isReadOnly(entry))
                            }
                        }
                    } header: {
                        if let label = group.label { Text(label) }
                    } footer: {
                        if group.id == groups.last?.id {
                            Text("Stored on this iPhone. They stay the same on every server you connect to.")
                        }
                    }
                }
            }
        } else {
            Section {
                ContentUnavailableView(
                    "Connect to a server to see these",
                    systemImage: "bolt.horizontal.circle",
                    description: Text("The server you chat on describes these settings. Their values stay on this iPhone.")
                )
            }
        }
    }
}

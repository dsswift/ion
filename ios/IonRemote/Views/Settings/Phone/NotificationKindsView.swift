import SwiftUI

/// Which resource kinds reach the notification inbox. A kind turned off stays
/// out of the inbox; conversation resources always stay in their
/// conversation's attachments. The choice is a Personal preference: it is
/// kept on this phone and applies on every server.
struct NotificationKindsView: View {
    @Environment(SessionViewModel.self) private var viewModel

    var body: some View {
        List {
            content
        }
        .navigationTitle(PhoneSettingsPage.notifications.title)
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private var content: some View {
        let state = viewModel.serverSettings
        if state?.schema.contains(where: { $0.key == NotificationKinds.key }) == true {
            let excluded = NotificationKinds.excluded(in: state)
            let kinds = NotificationKinds.kinds(seen: viewModel.resourceStore.items, excluded: excluded)
            Section {
                if kinds.isEmpty {
                    Text("No notification kinds yet. When an extension publishes a notification, its kind appears here.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(kinds, id: \.self) { kind in
                        Toggle(isOn: Binding(
                            get: { !excluded.contains(kind) },
                            set: { shown in save(NotificationKinds.excluded(excluded, setting: kind, shown: shown), kind: kind, shown: shown) }
                        )) {
                            Text(kind).font(.body.monospaced())
                        }
                    }
                }
            } header: {
                Text("Show in inbox")
            } footer: {
                Text("Turn a kind off to keep it out of your inbox. Stored on this iPhone.")
            }
        } else if state == nil {
            Section {
                ContentUnavailableView(
                    "Connect to a server to see these",
                    systemImage: "bolt.horizontal.circle",
                    description: Text("The server you chat on describes this setting. Its value stays on this iPhone.")
                )
            }
        } else {
            Section {
                Text("The connected server does not describe this setting. Update it to change it here.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
    }

    /// Saved the way every projected row saves: a Personal preference stays on this phone.
    private func save(_ excluded: [String], kind: String, shown: Bool) {
        viewModel.setServerSetting(key: NotificationKinds.key, value: NotificationKinds.value(excluded))
        DiagnosticLog.log("notification kind toggled", tag: "view.settings", fields: [
            "kind": kind, "shown": String(shown), "hidden_count": String(excluded.count)
        ])
        Haptic.light()
    }
}

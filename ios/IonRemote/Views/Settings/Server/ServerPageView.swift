import SwiftUI

/// One settings page of one server. Each section shows its dedicated admin
/// content first, then the projected settings the taxonomy files under it.
/// Rows save through the server's admin session, so this works for a server
/// the phone is not chatting on. Pulling the page down reloads every section
/// on it.
struct ServerPageView: View {
    let session: ServerAdminSession
    let page: ServerSettingsPage

    @State private var refresh: ServerPageRefresh

    init(session: ServerAdminSession, page: ServerSettingsPage) {
        self.session = session
        self.page = page
        _refresh = State(initialValue: ServerPageRefresh(serverId: session.serverId, pageId: page.id))
    }

    var body: some View {
        List {
            ForEach(page.sections) { section in
                ServerSectionView(session: session, pageId: page.id, section: section)
            }
        }
        .refreshable { await refresh.refresh() }
        .navigationTitle(page.label)
        .navigationBarTitleDisplayMode(.inline)
        .environment(\.projectedSettingsSource, .server(session))
        .environment(\.serverPageRefresh, refresh)
        .onAppear { session.open() }
        .onDisappear { session.close() }
    }
}

/// One section: its admin content and its projected rows, under its label.
struct ServerSectionView: View {
    let session: ServerAdminSession
    let pageId: String
    let section: ServerSettingsPage.Section

    var body: some View {
        let state = session.settings
        let entries = state?.entries(page: pageId, section: section.id) ?? []
        Section {
            ServerSectionContent(session: session, sectionId: section.id)
            if let state {
                ProjectedSectionRows(state: state, pageId: pageId, sectionId: section.id)
            }
        } header: {
            Text(section.label)
        } footer: {
            if let state, entries.contains(where: { state.isReadOnly($0) }) {
                Text("Greyed-out settings apply to the whole server. Only a device with admin access to \(session.serverLabel) can change them.")
            }
        }
    }
}

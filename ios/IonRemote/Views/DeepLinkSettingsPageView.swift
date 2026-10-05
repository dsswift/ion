import SwiftUI

/// The settings page an `ion://settings` link named, on the server the phone
/// is connected to. Waits for that server's settings snapshot, then shows the
/// page the same way Settings → Servers does.
struct DeepLinkSettingsPageView: View {
    let pageId: String

    @Environment(SessionViewModel.self) private var viewModel
    @State private var session: ServerAdminSession?

    var body: some View {
        Group {
            if let session {
                if let page = session.settings?.pages.first(where: { $0.id == pageId }) {
                    ServerPageView(session: session, page: page)
                } else if session.settings != nil {
                    ContentUnavailableView(
                        "No such page",
                        systemImage: "questionmark.folder",
                        description: Text("\(session.serverLabel) has no settings page this phone can show for that link.")
                    )
                } else {
                    ProgressView("Waiting for \(session.serverLabel)…")
                }
            } else {
                ContentUnavailableView(
                    "Not paired",
                    systemImage: "key.slash",
                    description: Text("Pair this phone with the server again to open its settings.")
                )
            }
        }
        .onAppear {
            guard session == nil, let device = viewModel.activeDevice else {
                if viewModel.activeDevice == nil {
                    DiagnosticLog.log("deep link settings: no active server", tag: "deeplink", level: .warn, fields: ["page_id": pageId])
                }
                return
            }
            let made = viewModel.adminSession(for: device)
            DiagnosticLog.log("deep link settings opened", tag: "deeplink", fields: ["page_id": pageId, "has_session": String(made != nil)])
            session = made
            made?.open()
        }
        .onDisappear { session?.close() }
    }
}

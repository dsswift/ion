import SwiftUI

/// The MCP servers section of a server: every configured server with its
/// state, each opening its detail page, and Add MCP Server.
struct McpAdminSection: View {
    let session: ServerAdminSession

    @State private var model: McpAdminModel
    @State private var showAdd = false
    @State private var removing: String?

    init(session: ServerAdminSession) {
        self.session = session
        _model = State(initialValue: McpAdminModel(session: session))
    }

    var body: some View {
        if let servers = model.servers {
            if servers.isEmpty {
                Text("No MCP servers yet. Add a remote URL or a local command; the engine connects it on the next conversation.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            ForEach(servers) { server in
                NavigationLink {
                    McpServerDetailView(session: session, model: model, name: server.name)
                } label: {
                    McpServerRow(server: server)
                }
                .swipeActions(edge: .trailing) {
                    if session.allows(.mcpRemove) {
                        Button("Remove", role: .destructive) { removing = server.name }
                    }
                }
            }
        } else if let error = model.loadError {
            AdminErrorRow(message: error)
        } else {
            AdminLoadingRow(text: "Loading MCP servers…")
        }
        if let error = model.operationError, !showAdd {
            AdminErrorRow(message: error)
        }
        // The always-present row carries the section's task and presentations,
        // so each runs once rather than once per row.
        Button {
            showAdd = true
        } label: {
            Label("Add MCP Server", systemImage: "plus")
        }
        .disabled(!session.allows(.mcpAdd))
        .task { await model.follow() }
        .reloadsWithServerPage("mcp") { [model] in await model.load() }
        .sheet(isPresented: $showAdd) { McpAddServerSheet(model: model) }
        .confirmationDialog(
            "Remove \(removing ?? "")?",
            isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
            titleVisibility: .visible,
            presenting: removing
        ) { name in
            Button("Remove Server", role: .destructive) {
                Task { if await model.remove(name) { Haptic.light() } }
            }
        } message: { _ in
            Text("Conversations started after this no longer get its tools. You can add it again later.")
        }
        if let reason = session.denialReason(.mcpAdd) {
            Text(reason).font(.footnote).foregroundStyle(.secondary)
        }
    }
}

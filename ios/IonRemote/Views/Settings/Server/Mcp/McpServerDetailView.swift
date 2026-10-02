import SwiftUI

/// One MCP server: where it lives, its state, its last error, and the verbs
/// to sign in, sign out, edit, or remove it.
struct McpServerDetailView: View {
    let session: ServerAdminSession
    @Bindable var model: McpAdminModel
    let name: String

    @Environment(\.dismiss) private var dismiss
    @State private var confirmRemove = false
    @State private var editing = false

    var body: some View {
        List {
            if let server = model.server(named: name) {
                content(server)
            } else if model.servers == nil {
                AdminLoadingRow(text: "Loading…")
            } else {
                Text("\(name) is no longer configured on \(model.serverLabel).").foregroundStyle(.secondary)
            }
        }
        .navigationTitle(name)
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { session.open() }
        .onDisappear { session.close() }
        .task { await model.follow() }
        .sheet(item: $model.pendingPaste) { paste in
            McpPasteAddressSheet(model: model, paste: paste)
        }
        .sheet(isPresented: $editing) {
            if let server = model.server(named: name) {
                McpEditServerSheet(model: model, server: server)
            }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button("Edit") { editing = true }
                    .disabled(model.server(named: name) == nil || model.server(named: name)?.managed == true || model.busyName == name || !session.allows(.mcpUpdate))
            }
        }
        .confirmationDialog("Remove \(name)?", isPresented: $confirmRemove, titleVisibility: .visible) {
            Button("Remove Server", role: .destructive) {
                Task {
                    if await model.remove(name) {
                        Haptic.light()
                        dismiss()
                    }
                }
            }
        } message: {
            Text("Removes it from the MCP configuration on \(model.serverLabel). Conversations started after this no longer get its tools. You can add it again later.")
        }
    }

    @ViewBuilder
    private func content(_ server: McpServerStatus) -> some View {
        let busy = model.busyName == name
        if let notice = model.notice {
            Section { Text(notice).font(.callout).foregroundStyle(.orange) }
        }
        Section {
            let endpoint = McpServerText.endpoint(server)
            if !endpoint.isEmpty {
                LabeledContent("Endpoint") {
                    Text(endpoint).font(.callout.monospaced()).textSelection(.enabled).multilineTextAlignment(.trailing)
                }
            }
            if let transport = server.transport, !transport.isEmpty {
                LabeledContent("Transport", value: transport)
            }
            LabeledContent("Connection") {
                HStack(spacing: IonSpace.compactGap) {
                    McpConnectionDot(server: server)
                    Text(server.connected ? "Connected" : "Not connected")
                }
            }
            LabeledContent("Authorization", value: server.authenticated ? "Authorized" : "Not authorized")
            if server.transport != "stdio" {
                LabeledContent("OAuth Client") {
                    if let clientId = server.oauth?.clientId, !clientId.isEmpty {
                        Text(clientId).font(.callout.monospaced()).textSelection(.enabled).multilineTextAlignment(.trailing)
                    } else {
                        Text("From discovery").foregroundStyle(.secondary)
                    }
                }
            }
            if let tools = McpServerText.toolCount(server) {
                LabeledContent("Tools", value: tools)
            }
        }
        if let lastError = server.lastError, !lastError.isEmpty {
            Section("Last Error") {
                Text(lastError).font(.callout).foregroundStyle(.orange).textSelection(.enabled)
            }
        }
        Section {
            Button {
                Task { await model.authorize(name) }
            } label: {
                Label(busy ? "Signing In…" : (server.authenticated ? "Re-authorize" : "Sign In"), systemImage: "person.badge.key")
            }
            .disabled(busy || !session.allows(.mcpLogin))
            if server.authenticated {
                Button {
                    Task { await model.signOut(name) }
                } label: {
                    Label("Sign Out", systemImage: "rectangle.portrait.and.arrow.right")
                }
                .disabled(busy || !session.allows(.mcpLogout))
            }
            Button(role: .destructive) {
                confirmRemove = true
            } label: {
                Label("Remove Server", systemImage: "trash")
            }
            .disabled(busy || server.managed == true || !session.allows(.mcpRemove))
        } footer: {
            if server.managed == true {
                Text("Your organization set up this server. It cannot be edited or removed here.")
            } else if let reason = session.denialReason(.mcpLogin) {
                Text(reason)
            } else {
                Text("Signing in opens the provider's page here. The engine on \(model.serverLabel) keeps the token and refreshes it.")
            }
        }
        if let error = model.operationError {
            Section { AdminErrorRow(message: error) }
        }
    }
}

import SwiftUI

/// Edits one MCP server: its URL or command, and for a remote server its OAuth
/// client. Only what changed is sent; the engine keeps every other setting,
/// and the stored client secret unless the person replaces or removes it.
struct McpEditServerSheet: View {
    let model: McpAdminModel
    let server: McpServerStatus

    @Environment(\.dismiss) private var dismiss
    @State private var endpoint: String
    @State private var oauth: McpOAuthDraft
    @State private var invalid: String?

    init(model: McpAdminModel, server: McpServerStatus) {
        self.model = model
        self.server = server
        _endpoint = State(initialValue: server.url ?? ([server.command ?? ""] + (server.args ?? [])).joined(separator: " "))
        _oauth = State(initialValue: McpOAuthDraft(status: server.oauth))
    }

    private var isLocal: Bool { server.transport == "stdio" }
    private var saving: Bool { model.busyName == server.name }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(isLocal ? "npx -y @scope/mcp-server" : "https://api.example.com/mcp", text: $endpoint)
                        .font(.body.monospaced())
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(isLocal ? .asciiCapable : .URL)
                } header: {
                    Text(isLocal ? "Command" : "URL")
                } footer: {
                    Text("Saved in the engine configuration on \(model.serverLabel). Settings not shown here are kept.")
                }
                if !isLocal {
                    McpOAuthFormSection(draft: $oauth)
                }
                if let message = invalid ?? model.operationError {
                    Section { AdminErrorRow(message: message) }
                }
            }
            .navigationTitle("Edit \(server.name)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Saving…" : "Save") { Task { await submit() } }
                        .disabled(saving)
                }
            }
            .onAppear { model.operationError = nil }
        }
    }

    private func submit() async {
        switch McpUpdateRequest.validate(server: server, endpoint: endpoint, oauth: oauth) {
        case .failure(let failure):
            invalid = failure.message
        case .success(let request):
            invalid = nil
            if await model.update(request) {
                Haptic.light()
                dismiss()
            }
        }
    }
}

import SwiftUI

/// Adds an MCP server to the server's engine: a remote URL, optionally with an
/// OAuth client, or a local command. The engine infers the transport and
/// connects it on the next conversation. Headers and environment variables
/// stay on the command line; signing in happens from the detail page.
struct McpAddServerSheet: View {
    let model: McpAdminModel

    @Environment(\.dismiss) private var dismiss
    @State private var kind: McpAddRequest.Kind = .remote
    @State private var name = ""
    @State private var endpoint = ""
    @State private var oauth = McpOAuthDraft()
    @State private var invalid: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Server kind", selection: $kind) {
                        ForEach(McpAddRequest.Kind.allCases) { Text($0.label).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .onChange(of: kind) { invalid = nil }
                }
                Section {
                    TextField("Name (e.g. mobbin)", text: $name)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField(kind == .remote ? "https://api.example.com/mcp" : "npx -y @scope/mcp-server", text: $endpoint)
                        .font(.body.monospaced())
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(kind == .remote ? .URL : .asciiCapable)
                } header: {
                    Text(kind == .remote ? "Name and URL" : "Name and command")
                } footer: {
                    Text("Saved in the engine configuration on \(model.serverLabel). It connects on the next conversation you start.")
                }
                if kind == .remote {
                    McpOAuthFormSection(draft: $oauth)
                }
                if let message = invalid ?? model.operationError {
                    Section { AdminErrorRow(message: message) }
                }
            }
            .navigationTitle("Add MCP Server")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(model.adding ? "Adding…" : "Add") { Task { await submit() } }
                        .disabled(model.adding)
                }
            }
            .onAppear { model.operationError = nil }
        }
    }

    private func submit() async {
        switch McpAddRequest.validate(kind: kind, name: name, endpoint: endpoint, oauth: oauth) {
        case .failure(let failure):
            invalid = failure.message
        case .success(let request):
            invalid = nil
            if await model.add(request) {
                Haptic.light()
                dismiss()
            }
        }
    }
}

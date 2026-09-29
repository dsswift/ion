import SwiftUI

/// Finishes an MCP sign-in the provider would not return to the app for: the
/// person opens the sign-in page in their browser, then pastes the address
/// of the last page it reached.
struct McpPasteAddressSheet: View {
    let model: McpAdminModel
    let paste: McpAdminModel.PendingPaste

    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var address = ""
    @State private var finishing = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Button {
                        openURL(paste.authorizationUrl)
                    } label: {
                        Label("Open the Sign-in Page", systemImage: "safari")
                    }
                    Button {
                        UIPasteboard.general.string = paste.authorizationUrl.absoluteString
                        Haptic.light()
                    } label: {
                        Label("Copy the Sign-in Link", systemImage: "doc.on.doc")
                    }
                } footer: {
                    Text("Sign in to \(paste.name) there. When the browser stops on a page that does not load, that page's address finishes the sign-in.")
                }
                Section {
                    TextField("Address of the last page", text: $address, axis: .vertical)
                        .font(.callout.monospaced())
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    Button("Paste") {
                        if let copied = UIPasteboard.general.string { address = copied }
                    }
                } header: {
                    Text("Copy the address of the last page and paste it here")
                }
                if let error = model.operationError {
                    Section { AdminErrorRow(message: error) }
                }
            }
            .navigationTitle("Finish Signing In")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        DiagnosticLog.log("mcp: pasted sign-in abandoned", tag: "admin.mcp", fields: ["name": paste.name])
                        model.pendingPaste = nil
                        dismiss()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(finishing ? "Finishing…" : "Finish") {
                        Task {
                            finishing = true
                            defer { finishing = false }
                            if await model.completePaste(paste, address: address) {
                                Haptic.light()
                                dismiss()
                            }
                        }
                    }
                    .disabled(finishing || address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}

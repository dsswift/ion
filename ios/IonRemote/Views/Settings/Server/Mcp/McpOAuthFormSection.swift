import SwiftUI

/// The optional OAuth client fields, shared by the Add and Edit sheets. Off by
/// default: most servers need none of this, and the engine fills every blank
/// field from the server's discovery metadata at sign-in.
struct McpOAuthFormSection: View {
    @Binding var draft: McpOAuthDraft

    var body: some View {
        Section {
            Toggle("Set the OAuth client", isOn: $draft.enabled)
            if draft.enabled {
                field("Client ID", text: $draft.clientId)
                if draft.hasStoredSecret && !draft.secretRemoved {
                    SecureField("Stored. Type a new one to replace it.", text: $draft.clientSecret)
                    Button("Remove Stored Secret", role: .destructive) {
                        draft.clientSecret = ""
                        draft.secretRemoved = true
                    }
                } else {
                    SecureField(draft.secretRemoved ? "Removed when you save" : "Client secret (optional)", text: $draft.clientSecret)
                }
                field("Scope", text: $draft.scope)
                field("Authorization URL (from discovery)", text: $draft.authUrl, url: true)
                field("Token URL (from discovery)", text: $draft.tokenUrl, url: true)
                field("Resource (from discovery)", text: $draft.resource)
            }
        } header: {
            Text("OAuth Client")
        } footer: {
            Text("Set a client ID when the sign-in provider cannot register Ion by itself, such as Microsoft Entra. Anything left blank comes from the server's discovery metadata. A secret is only for a confidential client.")
        }
    }

    private func field(_ prompt: String, text: Binding<String>, url: Bool = false) -> some View {
        TextField(prompt, text: text)
            .font(.body.monospaced())
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .keyboardType(url ? .URL : .asciiCapable)
    }
}

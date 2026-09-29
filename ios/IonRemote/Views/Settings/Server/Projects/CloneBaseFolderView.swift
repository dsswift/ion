import SwiftUI

/// Edits where new clones land on one server. Kept on this phone.
struct CloneBaseFolderView: View {
    let session: ServerAdminSession

    @State private var draft: String
    @Environment(\.dismiss) private var dismiss

    init(session: ServerAdminSession) {
        self.session = session
        _draft = State(initialValue: CloneBaseDirectory.read(serverId: session.serverId))
    }

    var body: some View {
        List {
            Section {
                TextField(CloneBaseDirectory.defaultValue, text: $draft)
                    .font(.body.monospaced())
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.done)
                    .onSubmit(save)
            } footer: {
                Text("New clones on \(session.serverLabel) land under this folder. \(CloneBaseDirectory.defaultValue) when blank. Kept on this phone.")
            }
        }
        .navigationTitle("Base Folder for Clones")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) { Button("Save", action: save) }
        }
    }

    private func save() {
        CloneBaseDirectory.write(draft, serverId: session.serverId)
        dismiss()
    }
}

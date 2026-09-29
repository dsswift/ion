import SwiftUI

/// Test repository access: runs `git ls-remote` on the server with the
/// credentials it holds, and lists what each URL answered.
struct GitTestAccessView: View {
    let session: ServerAdminSession

    @State private var model: GitTestAccessModel

    init(session: ServerAdminSession) {
        self.session = session
        _model = State(initialValue: GitTestAccessModel(serverId: session.serverId, client: session.client))
    }

    var body: some View {
        List {
            Section {
                TextField(model.suggestedURL ?? "git@github.com:org/repo.git", text: $model.typedURL)
                    .font(.body.monospaced())
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.go)
                    .onSubmit { Task { await model.test() } }
                Button(model.busy ? "Testing…" : "Test") { Task { await model.test() } }
                    .disabled(model.busy || model.url.isEmpty || !session.allows(.environmentGitTest))
            } header: {
                Text("Repository URL")
            } footer: {
                Text(session.denialReason(.environmentGitTest) ?? "Runs git ls-remote on \(session.serverLabel) with the credentials it holds.")
            }
            if let error = model.error {
                Section { AdminErrorRow(message: error) }
            }
            if !model.results.isEmpty {
                Section("Results") {
                    ForEach(model.results) { result in GitTestResultRow(result: result) }
                }
            }
        }
        .navigationTitle("Test Access")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.loadSuggestion() }
        .onAppear { session.open() }
        .onDisappear { session.close() }
    }
}

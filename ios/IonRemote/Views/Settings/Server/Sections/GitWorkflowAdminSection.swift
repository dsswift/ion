import SwiftUI

/// The git workflow section's own row: the saved source branch per directory.
/// GitOps mode, completion strategy, the commit command, and ignored
/// directories are projected settings and render below it.
struct GitWorkflowAdminSection: View {
    let session: ServerAdminSession

    @State private var model: BranchDefaultsModel

    init(session: ServerAdminSession) {
        self.session = session
        _model = State(initialValue: BranchDefaultsModel(session: session))
    }

    var body: some View {
        NavigationLink {
            BranchDefaultsView(session: session, model: model)
        } label: {
            LabeledContent("Branch Defaults") {
                if let entries = model.entries {
                    Text("\(entries.count)")
                } else if model.loadError != nil {
                    Text("Unavailable")
                } else {
                    Text("Loading…")
                }
            }
        }
        .task { await model.load() }
        .reloadsWithServerPage("git") { [model] in await model.load() }
    }
}

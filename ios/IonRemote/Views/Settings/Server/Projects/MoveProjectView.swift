import SwiftUI

/// Change location: pick the folder on the server to move a project into.
/// It keeps its folder name, and every worktree cut from it follows.
struct MoveProjectView: View {
    let session: ServerAdminSession
    let model: ProjectsAdminModel
    let project: EnvironmentProject
    let onMoved: (EnvironmentProject) -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        List {
            Section {
                Text("Pick the folder to move \(project.displayName) into. It moves as \(ProjectListRow.baseName(project.dir)) inside it.")
                    .foregroundStyle(.secondary)
            }
            if let error = model.operationError, error.dir == project.dir {
                Section { AdminErrorRow(message: error.message) }
            }
            ServerFolderBrowser(
                session: session,
                initialPath: parentFolder,
                pickLabel: "Move Here",
                disabled: model.isBusy(project.dir)
            ) { parent, _ in
                Task {
                    guard let moved = await model.relocate(project, intoParent: parent) else { return }
                    onMoved(moved)
                    dismiss()
                }
            }
        }
        .navigationTitle("Change Location")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { session.open() }
        .onDisappear { session.close() }
    }

    private var parentFolder: String {
        let parts = project.dir.split(separator: "/", omittingEmptySubsequences: false)
        let parent = parts.count > 1 ? parts.dropLast().joined(separator: "/") : "~"
        return parent.isEmpty ? "/" : parent
    }
}

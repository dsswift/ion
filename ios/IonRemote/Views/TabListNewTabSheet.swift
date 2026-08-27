import SwiftUI

/// Desktop-owned project picker for a new conversation, terminal, or worktree.
struct TabListNewTabSheet: View {
    @Environment(SessionViewModel.self) private var viewModel
    let projects: [RemoteProject]
    let pendingPinToGroupId: String?
    @Binding var isPresented: Bool
    let onNewConversation: (_ project: RemoteProject, _ pinToGroupId: String?) -> Void
    let onCreateWorktree: (_ repoPath: String, _ sourceBranch: String) -> Void
    let onCreateWorktreeConversation: (_ repoPath: String, _ sourceBranch: String) -> Void
    let onCreateTerminalTab: (_ directory: String) -> Void

    var body: some View {
        NavigationStack {
            List {
                Section("Projects") {
                    ForEach(projects) { project in
                        HStack {
                            VStack(alignment: .leading) {
                                Text(project.displayName).lineLimit(1)
                                Text(project.directory)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                            Spacer()
                            Button {
                                isPresented = false
                                onNewConversation(project, pendingPinToGroupId)
                            } label: {
                                Image(systemName: "plus")
                            }
                            .accessibilityLabel("New Conversation in \(project.displayName)")
                            .buttonStyle(.bordered)
                            .buttonBorderShape(.circle)
                            if let sourceBranch = viewModel.worktreeStates[project.directory]?.benches.first?.sourceBranch {
                                Button {
                                    isPresented = false
                                    onCreateWorktree(project.directory, sourceBranch)
                                } label: {
                                    Image(systemName: "arrow.triangle.branch")
                                }
                                .accessibilityLabel("Create worktree from \(sourceBranch)")
                                .buttonStyle(.bordered)
                                .buttonBorderShape(.circle)
                            }
                            Button {
                                isPresented = false
                                onCreateTerminalTab(project.directory)
                            } label: {
                                Image(systemName: "terminal")
                            }
                            .accessibilityLabel("New Terminal in \(project.displayName)")
                            .buttonStyle(.bordered)
                            .buttonBorderShape(.circle)
                        }
                    }
                }
            }
            .navigationTitle(pendingPinToGroupId == nil ? "New Conversation" : "New Conversation in Group")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { isPresented = false }
                }
            }
        }
        .presentationDetents([.medium])
    }
}

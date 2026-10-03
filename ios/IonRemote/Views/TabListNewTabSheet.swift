import SwiftUI

/// Desktop-owned project picker for a new conversation, terminal, or worktree.
struct TabListNewTabSheet: View {
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.appTheme) private var theme
    let projects: [RemoteProject]
    @Binding var isPresented: Bool
    let onNewConversation: (_ project: RemoteProject) -> Void
    let onCreateWorktree: (_ repoPath: String, _ sourceBranch: String) -> Void
    let onCreateWorktreeConversation: (_ repoPath: String, _ sourceBranch: String) -> Void
    let onCreateTerminalTab: (_ directory: String) -> Void

    var body: some View {
        NavigationStack {
            List {
                Section("Projects") {
                    ForEach(projects) { project in
                        // The row is the primary action: a new conversation
                        // in that project. The two rarer starts live in the
                        // row's trailing menu, each named, instead of three
                        // unlabeled round buttons to tell apart by glyph.
                        HStack(spacing: IonSpace.contentGap) {
                            Button {
                                isPresented = false
                                onNewConversation(project)
                            } label: {
                                HStack(spacing: IonSpace.contentGap) {
                                    Image(systemName: "folder")
                                        .font(IonType.meaning)
                                        .foregroundStyle(theme.accent)
                                        .frame(width: InboxLayout.iconColumn)
                                    VStack(alignment: .leading, spacing: 2) { // design-geometry: 2pt title-to-detail gap inside a two-line row; below the 4pt rhythm floor
                                        Text(project.displayName)
                                            .font(IonType.rowTitle)
                                            .foregroundStyle(theme.textPrimary)
                                            .lineLimit(1)
                                        Text(project.directory)
                                            .font(IonType.metadata)
                                            .foregroundStyle(theme.textTertiary)
                                            .lineLimit(1)
                                            .truncationMode(.head)
                                    }
                                    Spacer(minLength: 0)
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("New Conversation in \(project.displayName)")

                            Menu {
                                if let sourceBranch = viewModel.worktreeStates[project.directory]?.benches.first?.sourceBranch {
                                    Button {
                                        isPresented = false
                                        onCreateWorktree(project.directory, sourceBranch)
                                    } label: {
                                        Label("New worktree from \(sourceBranch)", systemImage: "arrow.triangle.branch")
                                    }
                                }
                                Button {
                                    isPresented = false
                                    onCreateTerminalTab(project.directory)
                                } label: {
                                    Label("New terminal", systemImage: "terminal")
                                }
                            } label: {
                                Image(systemName: "ellipsis")
                                    .font(IonType.meaning)
                                    .foregroundStyle(theme.textSecondary)
                                    .frame(width: IonSpace.screenInset, height: IonSpace.Metric.standardRowHeight)
                                    .contentShape(Rectangle())
                            }
                            .accessibilityLabel("More ways to start in \(project.displayName)")
                        }
                    }
                }
            }
            .navigationTitle("New Conversation")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { isPresented = false }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

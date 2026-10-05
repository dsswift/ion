import SwiftUI

/// The branch step of a worktree conversation: pick the source branch, say
/// whether the worktree is ephemeral, and whether to remember both for the
/// project so the next worktree conversation starts without this step.
struct WorktreeBranchChooserSheet: View {
    @Environment(\.appTheme) private var theme
    @Environment(\.dismiss) private var dismiss
    let repoPath: String
    /// Nil while the server's branch list is still on its way.
    let branches: [String]?
    /// The project's remembered branch, marked and listed first.
    let savedBranch: String?
    let ephemeralDefault: Bool
    let onChoose: (_ branch: String, _ ephemeral: Bool, _ remember: Bool) -> Void

    @State private var ephemeral: Bool
    @State private var remember = true

    init(repoPath: String, branches: [String]?, savedBranch: String?, ephemeralDefault: Bool,
         onChoose: @escaping (_ branch: String, _ ephemeral: Bool, _ remember: Bool) -> Void) {
        self.repoPath = repoPath
        self.branches = branches
        self.savedBranch = savedBranch
        self.ephemeralDefault = ephemeralDefault
        self.onChoose = onChoose
        _ephemeral = State(initialValue: ephemeralDefault)
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Toggle(isOn: $ephemeral) {
                        option("Ephemeral", "Removed when the conversation closes, unless it has unlanded work.")
                    }
                    Toggle(isOn: $remember) {
                        option("Remember for this project", "Next time, start from this branch without asking.")
                    }
                }
                Section("Source branch") {
                    if let branches {
                        ForEach(Self.ordered(branches, saved: savedBranch), id: \.self) { branch in
                            Button { choose(branch) } label: { row(branch) }
                        }
                    } else {
                        ProgressView()
                    }
                }
            }
            .navigationTitle("New worktree conversation")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    /// The remembered branch first, then the rest in the server's order.
    static func ordered(_ branches: [String], saved: String?) -> [String] {
        guard let saved, branches.contains(saved) else { return branches }
        return [saved] + branches.filter { $0 != saved }
    }

    private func option(_ title: String, _ hint: String) -> some View {
        VStack(alignment: .leading, spacing: IonSpace.hairlineGap) {
            Text(title)
                .font(IonType.rowTitle)
                .foregroundStyle(theme.textPrimary)
            Text(hint)
                .font(IonType.metadata)
                .foregroundStyle(theme.textSecondary)
        }
    }

    private func row(_ branch: String) -> some View {
        HStack {
            Text(branch)
                .font(IonType.rowTitle)
                .foregroundStyle(theme.textPrimary)
            Spacer()
            if branch == savedBranch {
                Image(systemName: "checkmark")
                    .foregroundStyle(theme.accent)
                    .accessibilityLabel("Remembered")
            }
        }
    }

    private func choose(_ branch: String) {
        DiagnosticLog.log("worktree branch chosen", tag: "view.inbox", fields: [
            "repo_path": repoPath,
            "source_branch": branch,
            "ephemeral": String(ephemeral),
            "remember": String(remember),
        ])
        onChoose(branch, ephemeral, remember)
        dismiss()
    }
}

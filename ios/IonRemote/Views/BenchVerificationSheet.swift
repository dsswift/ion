import SwiftUI

/// What a bench verification failure is, and the ways out. The phone's form of
/// the desktop's BenchVerificationDialog: same facts, same two verbs.
///
/// Reads the bench live from the view model, so the sheet follows the next
/// assembly instead of holding a stale copy of the failure.
struct BenchVerificationSheet: View {
    @Environment(SessionViewModel.self) private var viewModel
    @Environment(\.appTheme) private var theme
    @Environment(\.dismiss) private var dismiss
    let repoPath: String
    let sourceBranch: String
    @State private var confirmDiscard = false
    @State private var showOutput = false

    private var bench: RemoteBench? {
        viewModel.worktreeState(for: repoPath)?.benches.first { $0.sourceBranch == sourceBranch }
    }

    private var evidence: RemoteBenchVerification? {
        guard let bench, bench.lastAssemblyFailure == "verification" else { return nil }
        return bench.lastAssemblyVerification
    }

    var body: some View {
        NavigationStack {
            List {
                if let evidence {
                    failureSections(evidence)
                } else {
                    Section {
                        Text("The bench no longer has a verification failure.")
                            .foregroundStyle(theme.textSecondary)
                    }
                }
            }
            .navigationTitle("Verification failed")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .confirmationDialog(
                BenchVerificationCopy.discardPrompt(replayedBranches: evidence?.replayedBranches ?? []),
                isPresented: $confirmDiscard,
                titleVisibility: .visible
            ) {
                Button("Discard and reassemble", role: .destructive) {
                    guard let evidence else { return }
                    DiagnosticLog.log("bench verification: discard and reassemble", tag: "bench.verification", fields: [
                        "repo_path": repoPath, "source_branch": sourceBranch,
                        "branches": evidence.replayedBranches.joined(separator: ","),
                    ])
                    viewModel.discardBenchMemberRecordings(
                        repoPath: repoPath, sourceBranch: sourceBranch, branchNames: evidence.replayedBranches)
                    dismiss()
                }
                Button("Cancel", role: .cancel) {}
            }
        }
        .presentationDetents([.medium, .large])
    }

    @ViewBuilder
    private func failureSections(_ evidence: RemoteBenchVerification) -> some View {
        Section {
            Text(BenchVerificationCopy.headline(replayedBranches: evidence.replayedBranches))
                .foregroundStyle(theme.textPrimary)
        } footer: {
            Text("The bench is empty until this is fixed. \(BenchVerificationCopy.nextStep(replayedBranches: evidence.replayedBranches))")
        }

        Section {
            if !evidence.replayedBranches.isEmpty {
                Button(role: .destructive) {
                    confirmDiscard = true
                } label: {
                    Label(
                        evidence.replayedBranches.count == 1 ? "Discard saved fix and reassemble" : "Discard saved fixes and reassemble",
                        systemImage: "arrow.counterclockwise"
                    )
                }
            }
            Button {
                DiagnosticLog.log("bench verification: analysis requested", tag: "bench.verification", fields: [
                    "repo_path": repoPath, "source_branch": sourceBranch,
                ])
                viewModel.analyseBenchVerification(repoPath: repoPath, sourceBranch: sourceBranch)
                dismiss()
            } label: {
                Label("Ask AI why it failed", systemImage: "sparkle.magnifyingglass")
            }
        } footer: {
            Text("AI opens a read-only conversation. It tells you whether the saved fix is bad or two worktrees really disagree. It does not change code.")
        }
        .disabled(viewModel.worktreeActionsLocked(repoPath: repoPath))

        Section {
            DisclosureGroup("Command output", isExpanded: $showOutput) {
                Text(evidence.command)
                    .font(IonType.mono)
                    .foregroundStyle(theme.textSecondary)
                    .textSelection(.enabled)
                Text(evidence.outputTail.isEmpty ? "No output captured." : evidence.outputTail)
                    .font(IonType.mono)
                    .foregroundStyle(theme.textPrimary)
                    .textSelection(.enabled)
            }
        }
    }
}

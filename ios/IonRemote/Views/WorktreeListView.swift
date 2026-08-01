import SwiftUI

// MARK: - Worktree list + integration bench (pushed from the git pane)
//
// iOS's navigation shape drives what lives here. The git pane sits one layer
// BELOW a conversation, so this screen is two navigations from the tab list --
// acceptable for the low-frequency MANAGEMENT verbs (land, sync, rebuild,
// enable/disable) but not for "open a conversation in a worktree", which is
// surfaced in the new-tab sheet and the tab-row menu instead.

struct WorktreeListView: View {
    @Environment(SessionViewModel.self) private var viewModel
    let repoPath: String

    private var state: RemoteWorktreeState? { viewModel.worktreeState(for: repoPath) }

    var body: some View {
        List {
            benchSections
            worktreeSection
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Worktrees")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { viewModel.refreshWorktrees(repoPath: repoPath) }
        .task { viewModel.refreshWorktrees(repoPath: repoPath) }
        .overlay(alignment: .top) {
            if let toast = viewModel.gitToast {
                GitToastView(toast: toast) { viewModel.gitToast = nil }
                    .padding(.top, 8)
            }
        }
    }

    // MARK: - Benches

    @ViewBuilder
    private var benchSections: some View {
        ForEach(state?.benches ?? []) { bench in
            Section {
                benchHeader(bench)
                ForEach(bench.members) { member in
                    BenchMemberRowView(
                        member: member,
                        busy: viewModel.worktreeBusyPath == member.worktreePath,
                        onToggle: {
                            viewModel.setBenchMemberEnabled(
                                repoPath: repoPath, sourceBranch: bench.sourceBranch,
                                worktreePath: member.worktreePath, enabled: !member.enabled)
                        },
                        onUpdate: {
                            viewModel.updateBenchMember(
                                repoPath: repoPath, sourceBranch: bench.sourceBranch,
                                worktreePath: member.worktreePath)
                        },
                        onRemove: {
                            viewModel.removeBenchMember(
                                repoPath: repoPath, sourceBranch: bench.sourceBranch,
                                worktreePath: member.worktreePath)
                        })
                }
                addMemberMenu(bench)
            } header: {
                Text("Bench · \(bench.sourceBranch)")
            } footer: {
                if bench.conflictedMemberCount > 0 {
                    Text("\(bench.conflictedMemberCount) member(s) could not be merged and were skipped. The rest of the bench still built.")
                        .foregroundStyle(.red)
                }
            }
        }
    }

    @ViewBuilder
    private func benchHeader(_ bench: RemoteBench) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: "flask")
                    .foregroundStyle(.tint)
                VStack(alignment: .leading, spacing: 1) {
                    Text(bench.benchBranch)
                        .font(.subheadline.weight(.medium))
                    HStack(spacing: 6) {
                        if !bench.baseSha.isEmpty {
                            Text("base \(String(bench.baseSha.prefix(7)))")
                                .font(.caption2)
                                .foregroundStyle(bench.baseDrifted ? .orange : .secondary)
                        }
                        if bench.baseDrifted {
                            Text("source moved")
                                .font(.caption2)
                                .foregroundStyle(.orange)
                        }
                        Text(bench.hasBeenBuilt ? relativeBuilt(bench.lastBuiltAt) : "never built")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
            }

            HStack(spacing: 10) {
                // The button that makes the bench usable from a phone: open a
                // conversation in it, run the build, discuss -- without ever
                // needing the bench's generated path.
                Button {
                    viewModel.openBenchConversation(repoPath: repoPath, sourceBranch: bench.sourceBranch)
                    Haptic.medium()
                } label: {
                    Label(bench.openConversations.isEmpty ? "Open conversation" : "Go to conversation",
                          systemImage: "bubble.left")
                        .font(.caption)
                }
                .buttonStyle(.bordered)

                Button {
                    // Update-all when something is stale, plain rebuild
                    // otherwise. Rebuild alone advances no pin, so it is always
                    // safe to press.
                    if bench.staleMemberCount > 0 {
                        viewModel.updateAllBenchMembers(repoPath: repoPath, sourceBranch: bench.sourceBranch)
                    } else {
                        viewModel.rebuildBench(repoPath: repoPath, sourceBranch: bench.sourceBranch)
                    }
                    Haptic.medium()
                } label: {
                    Label(bench.staleMemberCount > 0 ? "Update all & rebuild" : "Rebuild",
                          systemImage: "arrow.clockwise")
                        .font(.caption)
                }
                .buttonStyle(.bordered)
                .disabled(viewModel.benchBusy)
            }
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private func addMemberMenu(_ bench: RemoteBench) -> some View {
        // Only worktrees cut from THIS bench's source branch, and not already
        // enrolled. A worktree from another branch belongs to that branch's
        // bench.
        let candidates = (state?.worktrees ?? []).filter { wt in
            wt.sourceBranch == bench.sourceBranch
                && !bench.members.contains { $0.worktreePath == wt.worktreePath }
        }
        if !candidates.isEmpty {
            Menu {
                ForEach(candidates) { wt in
                    Button(wt.label) {
                        viewModel.addBenchMember(repoPath: repoPath, sourceBranch: bench.sourceBranch, worktree: wt)
                    }
                }
            } label: {
                Label("Add worktree to bench", systemImage: "plus")
                    .font(.caption)
            }
        }
    }

    // MARK: - Worktrees

    @ViewBuilder
    private var worktreeSection: some View {
        Section("Worktrees") {
            if (state?.worktrees ?? []).isEmpty {
                Text("No worktrees for this project.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(state?.worktrees ?? []) { wt in
                    WorktreeRowView(
                        worktree: wt,
                        busy: viewModel.worktreeBusyPath == wt.worktreePath,
                        onOpen: { viewModel.openWorktreeConversation(worktreePath: wt.worktreePath) },
                        onSync: { viewModel.syncWorktree(wt, repoPath: repoPath) },
                        onLand: { viewModel.landWorktree(wt, repoPath: repoPath) })
                }
            }
        }
    }

    private func relativeBuilt(_ ms: Double) -> String {
        let secs = Int(Date().timeIntervalSince1970 - ms / 1000)
        if secs < 60 { return "built just now" }
        if secs < 3600 { return "built \(secs / 60)m ago" }
        if secs < 86_400 { return "built \(secs / 3600)h ago" }
        return "built \(secs / 86_400)d ago"
    }
}

import SwiftUI

// MARK: - Worktree list + integration bench (pushed from the git pane)
//
// iOS's navigation shape drives what lives here. The git pane sits one layer
// BELOW a conversation, so this screen is two navigations from the tab list --
// acceptable for the low-frequency MANAGEMENT verbs (land, sync, assemble,
// enable/disable) but not for "open a conversation in a worktree", which is
// surfaced in the new-tab sheet and the tab-row menu instead.

struct WorktreeListView: View {
    @Environment(SessionViewModel.self) private var viewModel
    let repoPath: String

    private var state: RemoteWorktreeState? { viewModel.worktreeState(for: repoPath) }

    var body: some View {
        List {
            benchBars
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

    /// The bench BAR only -- what the bench is and the two verbs that act on
    /// the whole of it. Its members are rows in the single worktree list below,
    /// because a member IS a worktree: listing them here as well is what made
    /// an enrolled worktree appear twice in two vocabularies.
    @ViewBuilder
    private var benchBars: some View {
        ForEach(state?.benches ?? []) { bench in
            Section {
                benchHeader(bench)
            } header: {
                Text("Bench · \(bench.sourceBranch)")
            } footer: {
                benchFooter(bench)
            }
        }
    }

    @ViewBuilder
    private func benchFooter(_ bench: RemoteBench) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            // Assembly is atomic on the desktop: a conflicted member fails the
            // WHOLE assembly and the bench is wiped empty. The footer must say
            // so — an operator who opens a bench terminal and finds nothing
            // must have been told why here.
            if bench.lastAssembly == "failed" {
                Text(bench.lastAssemblyError
                     ?? "The last assembly failed. The bench is empty until the conflict is resolved.")
                    .foregroundStyle(.red)
            }
            // Memberships with no worktree left. They have no directory to open,
            // so they are a footnote rather than rows -- but letting them vanish
            // is what made absorption read as the bench eating a worktree.
            if !bench.orphans.isEmpty {
                Text("\(bench.orphans.count) member(s) have no worktree any more.")
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
                        // "assembly failed" outranks the age: the age line implies a
                        // usable bench and a failed assembly left an EMPTY one.
                        if bench.lastAssembly == "failed" {
                            Text("assembly failed")
                                .font(.caption2)
                                .foregroundStyle(.red)
                        } else {
                            Text(bench.hasBeenBuilt ? relativeAssembled(bench.lastBuiltAt) : "never assembled")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                Spacer()
            }

            benchVerbs(bench)
        }
        .padding(.vertical, 2)
    }

    /// The two verbs that act on the whole bench: get a shell in it, assemble
    /// it. Open-conversation is deliberately absent, mirroring the desktop
    /// bench bar: a conversation in the bench invites development work that
    /// the next assembly destroys, the terminal covers building and testing,
    /// and fix conversations belong in the member worktree that owns the
    /// file. The `openBenchConversation` command still exists on the wire —
    /// only the operator-facing affordance is hidden.
    ///
    /// `ViewThatFits` because bordered buttons with full labels
    /// ("Go to terminal" + "Update all & assemble") can exceed a narrow
    /// phone. The first layout is tried and the icon-only fallback is used
    /// when it does not fit, so a narrow device drops the words rather than
    /// truncating them mid-label or clipping the assemble button off the
    /// edge. The icon-only arm carries accessibility labels, which the
    /// `Label` text supplies for free in the wide arm.
    @ViewBuilder
    private func benchVerbs(_ bench: RemoteBench) -> some View {
        let behind = state?.behindMemberCount(of: bench) ?? 0
        let terminalTitle = bench.benchTerminalTabId == nil ? "Open terminal" : "Go to terminal"
        let assembleTitle = behind > 0 ? "Update all & assemble" : "Assemble"

        ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) {
                benchTerminalButton(bench, title: terminalTitle, iconOnly: false)
                benchAssembleButton(bench, title: assembleTitle, behind: behind, iconOnly: false)
            }
            HStack(spacing: 10) {
                benchTerminalButton(bench, title: terminalTitle, iconOnly: true)
                benchAssembleButton(bench, title: assembleTitle, behind: behind, iconOnly: true)
            }
        }
    }

    /// A shell in the bench rather than a conversation about it. One terminal per
    /// bench, so this returns to the same tab and its scrollback instead of
    /// stacking shells.
    @ViewBuilder
    private func benchTerminalButton(
        _ bench: RemoteBench, title: String, iconOnly: Bool,
    ) -> some View {
        Button {
            viewModel.openBenchTerminal(repoPath: repoPath, sourceBranch: bench.sourceBranch)
            Haptic.medium()
        } label: {
            benchVerbLabel(title, systemImage: "terminal", iconOnly: iconOnly)
        }
        .buttonStyle(.bordered)
    }

    @ViewBuilder
    private func benchAssembleButton(
        _ bench: RemoteBench, title: String, behind: Int, iconOnly: Bool,
    ) -> some View {
        Button {
            // Update-all when something is stale, plain assembly otherwise.
            // Assembly alone advances no pin, so it is always safe to press.
            if behind > 0 {
                viewModel.updateAllBenchMembers(repoPath: repoPath, sourceBranch: bench.sourceBranch)
            } else {
                viewModel.assembleBench(repoPath: repoPath, sourceBranch: bench.sourceBranch)
            }
            Haptic.medium()
        } label: {
            benchVerbLabel(title, systemImage: "arrow.clockwise", iconOnly: iconOnly)
        }
        .buttonStyle(.bordered)
        .disabled(viewModel.benchBusy)
    }

    @ViewBuilder
    private func benchVerbLabel(_ title: String, systemImage: String, iconOnly: Bool) -> some View {
        if iconOnly {
            Image(systemName: systemImage)
                .font(.caption)
                .accessibilityLabel(title)
        } else {
            Label(title, systemImage: systemImage)
                .font(.caption)
        }
    }

    // MARK: - Worktrees

    @ViewBuilder
    private var worktreeSection: some View {
        Section {
            if (state?.worktrees ?? []).isEmpty {
                Text("No worktrees for this project.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                // Three bands, matching the desktop's shared sort: enrolled in
                // merge order, then active, then landed.
                ForEach(sortedWorktrees) { wt in
                    WorktreeRowView(
                        worktree: wt,
                        busy: viewModel.worktreeBusyPath == wt.worktreePath,
                        onOpen: { viewModel.openWorktreeConversation(worktreePath: wt.worktreePath) },
                        onSync: { viewModel.syncWorktree(wt, repoPath: repoPath) },
                        onLand: { viewModel.landWorktree(wt, repoPath: repoPath) },
                        onToggleEnrollment: { toggleEnrollment(wt) },
                        onToggleIncluded: {
                            guard let m = wt.membership else { return }
                            viewModel.setBenchMemberEnabled(
                                repoPath: repoPath, sourceBranch: m.sourceBranch,
                                worktreePath: wt.worktreePath, enabled: !m.enabled)
                        },
                        onUpdatePin: {
                            guard let m = wt.membership else { return }
                            viewModel.updateBenchMember(
                                repoPath: repoPath, sourceBranch: m.sourceBranch,
                                worktreePath: wt.worktreePath)
                        },
                        onSetReview: { review in
                            guard let m = wt.membership else { return }
                            viewModel.setBenchMemberReview(
                                repoPath: repoPath, sourceBranch: m.sourceBranch,
                                worktreePath: wt.worktreePath, review: review?.rawValue)
                        },
                        onNewConversation: { viewModel.newWorktreeConversation(worktreePath: wt.worktreePath) })
                }
            }
        } header: {
            Text("Worktrees")
        } footer: {
            // The desktop draws a divider before the landed rows; a List section
            // cannot, so the count says it instead. Same fact, native shape.
            if landedCount > 0 {
                Text("\(landedCount) landed, listed last — nothing left to commit or land.")
            }
        }
    }

    /// Three bands, mirroring `buildWorktreeList` on the desktop so both clients
    /// present one order: enrolled in merge order, then active, then landed.
    ///
    /// Landedness is the OUTERMOST band, ahead of enrollment. A landed worktree
    /// needs no attention even while it is still nominally a bench member, and
    /// ranking enrollment first kept a just-landed row pinned to the top of the
    /// list. It also reads `isLanded` rather than `safeToDiscard`: the latter is
    /// "nothing to lose", which is equally true of a worktree that never
    /// committed anything.
    private var sortedWorktrees: [RemoteWorktree] {
        let all = state?.worktrees ?? []
        let active = all.filter { !$0.isLanded }
        let enrolled = active.filter { $0.membership != nil }
            .sorted { ($0.membership?.order ?? 0) < ($1.membership?.order ?? 0) }
        return enrolled + active.filter { $0.membership == nil } + all.filter(\.isLanded)
    }

    /// Worktrees whose work is done, for the section footer.
    private var landedCount: Int {
        (state?.worktrees ?? []).filter(\.isLanded).count
    }

    /// Enroll into the bench for this worktree's own source branch, or remove it
    /// from whichever bench holds it. Which bench is fully determined by the
    /// source branch, so there is nothing to choose.
    private func toggleEnrollment(_ wt: RemoteWorktree) {
        if let m = wt.membership {
            viewModel.removeBenchMember(
                repoPath: repoPath, sourceBranch: m.sourceBranch, worktreePath: wt.worktreePath)
        } else if let source = wt.sourceBranch {
            viewModel.addBenchMember(repoPath: repoPath, sourceBranch: source, worktree: wt)
        }
    }

    private func relativeAssembled(_ ms: Double) -> String {
        let secs = Int(Date().timeIntervalSince1970 - ms / 1000)
        if secs < 60 { return "assembled just now" }
        if secs < 3600 { return "assembled \(secs / 60)m ago" }
        if secs < 86_400 { return "assembled \(secs / 3600)h ago" }
        return "assembled \(secs / 86_400)d ago"
    }
}

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
    @State private var confirmRetireAllLanded = false

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
                    .padding(.top, IonSpace.compactGap)
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
            //
            // A verification failure is a DIFFERENT fact: every merge succeeded
            // (including any replayed rerere resolution), and the project's own
            // verify command rejected the resulting tree. There is no member to
            // point at, so the footer names the command and its output instead
            // of the generic conflict wording.
            if bench.lastAssembly == "failed" && bench.lastAssemblyFailure == "verification" {
                let evidence = bench.lastAssemblyVerification
                Text("Project verification rejected the assembled tree.")
                    .foregroundStyle(.orange)
                if let command = evidence?.command, !command.isEmpty {
                    Text(command)
                        .ionType(.mono)
                        .foregroundStyle(.secondary)
                }
                if let output = evidence?.outputTail, !output.isEmpty {
                    Text(output)
                        .ionType(.mono)
                        .foregroundStyle(.secondary)
                        .lineLimit(4)
                }
                if let replayed = evidence?.replayedBranches, !replayed.isEmpty {
                    Text("Suspects: \(replayed.joined(separator: ", "))")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Text("Resolution (discard recordings, or AI-assisted analysis) is desktop-only.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            } else if bench.lastAssembly == "failed" {
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
                        // Distinct wording for a verification failure -- an operator
                        // reading "assembly failed" would go looking for a conflict
                        // that does not exist here.
                        if bench.lastAssembly == "failed" && bench.lastAssemblyFailure == "verification" {
                            Text("verification failed")
                                .font(.caption2)
                                .foregroundStyle(.orange)
                        } else if bench.lastAssembly == "failed" {
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
        .padding(.vertical, 2) // design-geometry: tight 2pt inset; below the 4pt rhythm floor
    }

    /// Bench actions stay compact on narrow phones. Full labels fit when space
    /// allows; icon-only controls preserve all actions without truncation.
    @ViewBuilder
    private func benchVerbs(_ bench: RemoteBench) -> some View {
        let behind = state?.behindMemberCount(of: bench) ?? 0
        let talkTitle = bench.conversationActionTitle
        let terminalTitle = bench.benchTerminalTabId == nil ? "Terminal" : "Go to terminal"
        let assembleTitle = behind > 0 ? "Update all & assemble" : "Assemble"

        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) {
                benchConversationButton(bench, title: talkTitle, iconOnly: false)
                benchTerminalButton(bench, title: terminalTitle, iconOnly: false)
                benchAssembleButton(bench, title: assembleTitle, behind: behind, iconOnly: false)
            }
            HStack(spacing: 8) {
                benchConversationButton(bench, title: talkTitle, iconOnly: true)
                benchTerminalButton(bench, title: terminalTitle, iconOnly: true)
                benchAssembleButton(bench, title: assembleTitle, behind: behind, iconOnly: true)
            }
        }
    }

    @ViewBuilder
    private func benchConversationButton(
        _ bench: RemoteBench, title: String, iconOnly: Bool,
    ) -> some View {
        Button {
            viewModel.openBenchConversation(repoPath: repoPath, sourceBranch: bench.sourceBranch)
            Haptic.medium()
        } label: {
            benchVerbLabel(title, systemImage: "bubble.left", iconOnly: iconOnly)
        }
        .buttonStyle(.bordered)
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
            // The bulk verb, shown only when it has something to do — mirrors
            // the desktop's Sync-all placement above the rows it acts on. iOS
            // triggers the desktop's MECHANICAL pass only (sequential rebases
            // + recorded-resolution replay); the AI escalation is desktop-only
            // and its confirm gate lives there.
            if actionableSyncCount > 0 {
                Button {
                    viewModel.syncAllWorktrees(repoPath: repoPath)
                    Haptic.medium()
                } label: {
                    Label("Sync all · \(actionableSyncCount)", systemImage: "arrow.triangle.2.circlepath")
                        .font(.caption)
                }
                .buttonStyle(.bordered)
                .disabled(viewModel.benchBusy)
            }
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
                        onSetStage: { stage in
                            viewModel.setWorktreeStage(
                                repoPath: repoPath,
                                worktreePath: wt.worktreePath, stage: stage?.rawValue)
                        },
                        onNewConversation: { viewModel.newWorktreeConversation(worktreePath: wt.worktreePath) },
                        onSelectConversation: { viewModel.navigateToTab($0) },
                        onRetire: { viewModel.retireWorktree(wt, repoPath: repoPath) })
                }
            }
        } header: {
            Text("Worktrees")
        } footer: {
            // The desktop draws a divider before the landed rows; a List section
            // cannot, so the count says it instead. Same fact, native shape.
            if landedCount > 0 {
                VStack(alignment: .leading, spacing: 6) {
                    Text("\(landedCount) landed, listed last — nothing left to commit or land.")
                    Button(role: .destructive) {
                        confirmRetireAllLanded = true
                    } label: {
                        Label("Retire all landed · \(landedCount)", systemImage: "trash")
                            .font(.caption)
                    }
                    .buttonStyle(.bordered)
                    .disabled(viewModel.benchBusy)
                }
                .confirmationDialog("Retire all landed worktrees?",
                                    isPresented: $confirmRetireAllLanded,
                                    titleVisibility: .visible) {
                    Button("Retire \(landedCount)", role: .destructive) {
                        viewModel.retireAllLandedWorktrees(repoPath: repoPath)
                        Haptic.medium()
                    }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("Retire \(landedCount) sealed worktree\(landedCount == 1 ? "" : "s")? Their review conversations and terminals will close.")
                }
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

    /// Rows the bulk sync pass could act on: base-stale or stuck mid-operation.
    /// Dirty-but-stale rows count too — the pass reports them as skipped, which
    /// is itself the answer ("why didn't it sync? dirty"). Same predicate as
    /// the desktop's WorktreePipelinePanel, so the verb appears in lockstep.
    private var actionableSyncCount: Int {
        (state?.worktrees ?? []).filter { $0.needsSync || $0.operationState != nil }.count
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

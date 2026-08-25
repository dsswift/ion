import SwiftUI

/// Inbox host for the existing worktree management row. It preserves the row's
/// command surface while adding disclosure and authoritative conversation rows.
///
/// Parity contract (desktop: studio/inbox/InboxWorktreeRow.tsx):
///   - The header is the enriched worktree card: enrollment, dirty, unlanded
///     count, state indicators (conflict / bench conflict / pin / sync /
///     provisioning), title, branch, conversation count, and the slug + last
///     commit second line — all rendered by WorktreeRowView.
///   - Conflict indicators flash while an auto-fix conversation runs and route
///     their tap to that conversation (reactivation block); otherwise they
///     launch the AI-assisted resolution. Manual 3-pane merge is desktop-only.
///   - Conversation rows below the header carry the FULL inbox action set
///     (settle/snooze/unread/pin/rename/delete), identical to top-level rows;
///     the host injects them via `row` so one builder serves every location.
struct InboxWorktreeGroup<Row: View>: View {
    @Environment(SessionViewModel.self) private var viewModel
    let repoPath: String
    let worktree: RemoteWorktree
    let tabs: [RemoteTabState]
    @State private var showRename = false
    @State private var renameTitle = ""
    @State private var confirmDiscardRecordings = false
    @State private var confirmDiscard = false
    let activeTabId: String?
    @Binding var expanded: Set<String>
    /// True only in the side-by-side layout. When false (iPhone), tapping the
    /// header expands/collapses instead of cycling conversations: a tap that
    /// pushes a conversation navigates away from the list, so a "cycle" is a
    /// round trip the operator cannot see. Explicit open verbs stay in the
    /// context menu either way. See InboxNavigator.headerTapCycles.
    var cyclesOnHeaderTap: Bool = true
    /// Full-featured inbox conversation row, supplied by TabListView+Inbox so
    /// rows inside a worktree group are IDENTICAL to rows anywhere else.
    @ViewBuilder let row: (RemoteTabState) -> Row

    private var expansionKey: String { InboxNavigator.worktreeExpansionKey(worktree.worktreePath) }
    private var isExpanded: Bool { expanded.contains(expansionKey) }

    var body: some View {
        WorktreeRowView(
            worktree: worktree,
            busy: viewModel.worktreeBusyPath == worktree.worktreePath,
            onOpen: { headerTap() },
            onSync: { viewModel.syncWorktree(worktree, repoPath: repoPath) },
            onLandAndRetire: { viewModel.landAndRetireWorktree(worktree, repoPath: repoPath) },
            onToggleEnrollment: { toggleEnrollment() },
            onUpdatePin: { updatePin() },
            onRename: { renameTitle = worktree.displayName; showRename = true },
            onReprovision: { viewModel.reprovisionWorktree(repoPath: repoPath, worktreePath: worktree.worktreePath) },
            onMoveEarlier: { reorder(delta: -1) },
            onMoveLater: { reorder(delta: 1) },
            onDiscardRecordings: { confirmDiscardRecordings = true },
            onSetStage: { viewModel.setWorktreeStage(repoPath: repoPath, worktreePath: worktree.worktreePath, stage: $0?.rawValue) },
            onNewConversation: { viewModel.newWorktreeConversation(worktreePath: worktree.worktreePath) },
            onSelectConversation: { viewModel.navigateToTab($0) },
            verificationFailure: verificationFailure,
            onRetire: { confirmDiscard = true },
            activeAutoFixTabId: InboxNavigator.activeAutoFixTab(viewModel.tabs, directory: worktree.worktreePath)?.id,
            benchAutoFixTabId: benchAutoFixTabId,
            onConflictAssist: { viewModel.worktreeConflictAssist(worktree, repoPath: repoPath) },
            onBenchConflictAssist: {
                guard let sourceBranch = worktree.membership?.sourceBranch else { return }
                viewModel.benchConflictAssist(repoPath: repoPath, sourceBranch: sourceBranch)
            },
        )
        .overlay(alignment: .trailing) {
            Button {
                toggle()
            } label: {
                Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                    .font(.caption)
                    .padding(IonSpace.compactGap)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(isExpanded ? "Collapse worktree" : "Expand worktree")
        }
        .alert("Rename worktree", isPresented: $showRename) {
            TextField("Worktree name", text: $renameTitle)
            Button("Save") {
                viewModel.renameWorktree(repoPath: repoPath, worktreePath: worktree.worktreePath, title: renameTitle)
            }
            Button("Cancel", role: .cancel) {}
        }
        .confirmationDialog("Discard recorded resolutions?", isPresented: $confirmDiscardRecordings, titleVisibility: .visible) {
            Button("Discard recordings", role: .destructive) {
                guard let membership = worktree.membership else { return }
                viewModel.discardBenchMemberRecordings(repoPath: repoPath, sourceBranch: membership.sourceBranch, branchNames: [worktree.branchName])
            }
            Button("Cancel", role: .cancel) {}
        }
        .confirmationDialog(discardSummary, isPresented: $confirmDiscard, titleVisibility: .visible) {
            Button("Discard worktree", role: .destructive) {
                viewModel.retireWorktree(worktree, repoPath: repoPath)
            }
            Button("Keep it", role: .cancel) {}
        }

        let visibleTabs = isExpanded ? tabs : InboxNavigator.collapsedRows(tabs, activeTabId: activeTabId)
        ForEach(visibleTabs) { tab in
            row(tab)
                .padding(.leading, IonSpace.sectionGap)
        }
        if isExpanded && tabs.isEmpty && !worktree.isLanded {
            Button("New conversation here") {
                viewModel.newWorktreeConversation(worktreePath: worktree.worktreePath)
            }
            .font(.caption)
            .padding(.leading, IonSpace.sectionGap)
        }
    }

    /// The appraisal facts the desktop's confirm dialog names, from state the
    /// phone already holds. The desktop re-appraises at execution time and can
    /// still refuse, so a stale count here is advisory, never load-bearing.
    private var discardSummary: String {
        var parts: [String] = []
        if worktree.isDirty { parts.append("uncommitted changes") }
        if worktree.unlandedCommitCount > 0 {
            let n = worktree.unlandedCommitCount
            parts.append("\(n) commit\(n == 1 ? "" : "s") not yet landed")
        }
        guard !parts.isEmpty else { return "Discard this worktree? Its checkout and branch are removed. Nothing merges into its source branch." }
        return "This worktree holds \(parts.joined(separator: " and ")). Discarding removes its checkout and branch without merging; the desktop saves work under recovery refs first."
    }

    private var benchAutoFixTabId: String? {
        guard let membership = worktree.membership,
              let benchPath = viewModel.worktreeState(for: repoPath)?.benches
                .first(where: { $0.sourceBranch == membership.sourceBranch })?.benchPath else { return nil }
        return InboxNavigator.activeAutoFixTab(viewModel.tabs, directory: benchPath)?.id
    }

    private var verificationFailure: RemoteBenchVerification? {
        guard let membership = worktree.membership,
              membership.mergeResolution == "replayed" else { return nil }
        return viewModel.worktreeState(for: repoPath)?.benches
            .first(where: { $0.sourceBranch == membership.sourceBranch && $0.lastAssemblyFailure == "verification" })?
            .lastAssemblyVerification
    }

    /// What a tap on the worktree header does. Side-by-side: cycle (or create
    /// the first conversation). Pushed layout: expand/collapse only — the
    /// context menu's "Open conversation" / "New conversation here" remain the
    /// explicit navigation verbs there.
    private func headerTap() {
        guard cyclesOnHeaderTap else {
            toggle()
            return
        }
        cycleOrCreate()
    }

    private func cycleOrCreate() {
        let cycle = InboxNavigator.prepareWorktreeCycle(
            tabs,
            currentTabId: activeTabId,
            worktreePath: worktree.worktreePath,
            expansion: &expanded
        )
        if cycle.didExpand {
            DiagnosticLog.log("expanded worktree before cycling conversations", tag: "view.inbox", fields: [
                "worktree_path": worktree.worktreePath,
                "conversation_count": String(tabs.count)
            ])
        }
        if let next = cycle.next {
            viewModel.navigateToTab(next.id)
        } else {
            viewModel.openWorktreeConversation(worktreePath: worktree.worktreePath)
        }
    }

    private func toggle() {
        if isExpanded { expanded.remove(expansionKey) } else { expanded.insert(expansionKey) }
    }

    private func toggleEnrollment() {
        if let membership = worktree.membership {
            viewModel.removeBenchMember(repoPath: repoPath, sourceBranch: membership.sourceBranch, worktreePath: worktree.worktreePath)
        } else if let sourceBranch = worktree.sourceBranch {
            viewModel.addBenchMember(repoPath: repoPath, sourceBranch: sourceBranch, worktree: worktree)
        }
    }

    private func reorder(delta: Int) {
        guard let membership = worktree.membership else { return }
        let nextIndex = max(0, membership.order - 1 + delta)
        viewModel.reorderBenchMember(
            repoPath: repoPath,
            sourceBranch: membership.sourceBranch,
            worktreePath: worktree.worktreePath,
            toIndex: nextIndex
        )
    }

    private func updatePin() {
        guard let membership = worktree.membership else { return }
        viewModel.updateBenchMember(repoPath: repoPath, sourceBranch: membership.sourceBranch, worktreePath: worktree.worktreePath)
    }
}

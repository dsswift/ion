import SwiftUI

/// Bench assembly-age wording, shared with tests. Non-generic namespace so
/// callers do not have to name InboxBenchGroup's Row parameter.
enum BenchAssemblyTime {
    /// "assembled 5m ago", matching the desktop's wording (both BenchBar.tsx and
    /// InboxBenchBar.tsx) so the two clients never disagree on how bench age
    /// reads. `lastBuiltAt` is Unix ms; 0 means never assembled.
    static func relative(_ lastBuiltAtMs: Double) -> String {
        guard lastBuiltAtMs > 0 else { return "never assembled" }
        let date = Date(timeIntervalSince1970: lastBuiltAtMs / 1000)
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return "assembled \(formatter.localizedString(for: date, relativeTo: Date()))"
    }

    /// The bench header's one-line status: how many members the bench holds,
    /// how many are out of date, and when it was last assembled.
    ///
    /// Mirrors the desktop's `benchMemberSummary` (shared/worktree-list.ts).
    /// Each fact is useless alone: an age with no counts cannot tell the
    /// operator whether "9h ago" is fine or badly stale, and a behind-count
    /// that REPLACES the age (which this used to do) hides how old the build
    /// is — a bench that had silently lost every member read exactly like a
    /// healthy one.
    ///
    /// `total` and `behind` are counted by the caller from the snapshot's
    /// worktree records, so this stays a pure function of the three numbers
    /// and can be asserted directly rather than through a rendered view.
    static func summary(total: Int, behind: Int, lastBuiltAtMs: Double) -> String {
        if total == 0 { return "no members" }
        let members = "\(total) member\(total == 1 ? "" : "s")"
        let age = relative(lastBuiltAtMs)
        return behind > 0 ? "\(members) · \(behind) out of date · \(age)" : "\(members) · \(age)"
    }
}

/// Inbox host for bench controls. The desktop worktree projection owns the
/// inventory and bench facts. This group only renders and sends existing verbs.
///
/// Parity contract (desktop: studio/inbox/InboxBenchBar.tsx + InboxBenchMenu):
///   - The bench group renders whenever a bench EXISTS — even with zero open
///     conversations (the desktop's permanent-singleton-bucket rule). The host
///     mounts this view unconditionally per project with benches.
///   - Sync All runs the FULL pipeline (mechanical pass → AI-confirm gate →
///     agents → assembly), mirroring the desktop's button. The live banner and
///     the confirm gate render from `viewModel.worktreePipelines`.
///   - Conversation rows carry the full inbox action set via the injected
///     `row` builder, plus the auto-fix flashing overlay.
struct InboxBenchGroup<Row: View>: View {
    @Environment(SessionViewModel.self) private var viewModel
    let state: RemoteWorktreeState
    let tabsByBenchPath: [String: [RemoteTabState]]
    let terminalTabsByID: [String: RemoteTabState]
    let activeTabId: String?
    @Binding var expanded: Set<String>
    /// True only in the side-by-side layout — see
    /// InboxNavigator.headerTapCycles. When false (iPhone), the bench title
    /// expands/collapses; "Open Bench Conversation" in the overflow menu is
    /// the explicit navigation verb.
    var cyclesOnHeaderTap: Bool = true
    /// Full-featured inbox conversation row (same builder as worktree groups).
    @ViewBuilder let row: (RemoteTabState) -> Row
    @State private var confirmPipelineAi = false

    var body: some View {
        ForEach(state.benches) { bench in
            let key = "bench:\(bench.benchPath)"
            let benchTabs = tabsByBenchPath[bench.benchPath] ?? []
            let conversationTabs = benchTabs.filter { $0.id != bench.benchTerminalTabId }
            let terminalTab = bench.benchTerminalTabId.flatMap { terminalTabsByID[$0] }
            let occupants = terminalTab.map { conversationTabs + [$0] } ?? conversationTabs
            let isExpanded = expanded.contains(key)
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Image(systemName: "flask").foregroundStyle(.tint)
                    Button {
                        if cyclesOnHeaderTap {
                            cycleBenchConversation(bench)
                        } else {
                            toggle(key)
                        }
                    } label: {
                        Text("Bench · \(bench.sourceBranch)")
                    }
                    .buttonStyle(.plain)
                    .contextMenu {
                        benchActionMenu(bench)
                    }
                    // Conversation count uses the role-inclusive list. An empty
                    // bench omits the indicator; positive counts remain visible.
                    if !bench.openConversations.isEmpty {
                        Text("\(bench.openConversations.count)")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button {
                        openBenchTerminal(bench)
                    } label: {
                        Image(systemName: "terminal")
                            .font(.caption)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(bench.benchTerminalTabId == nil ? "Open bench terminal" : "Go to bench terminal")
                    Button {
                        toggle(key)
                    } label: {
                        Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                            .font(.caption)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(isExpanded ? "Collapse bench" : "Expand bench")
                }

                // The bench is a sibling group to worktrees, not a child action
                // list. Keep its workspace-wide sync control and its current
                // assembly state in the header's second row so they remain
                // visible while the conversation list is collapsed.
                HStack(spacing: 8) {
                    Button("Sync All") {
                        // The desktop's Sync All is the full pipeline with the
                        // AI cost gate — not the mechanical-only bulk sync.
                        viewModel.startWorktreePipeline(repoPath: state.repoPath, sourceBranch: bench.sourceBranch)
                    }
                    .buttonStyle(.bordered)
                    .font(.caption)
                    .disabled(viewModel.benchBusy || pipelineRunning)

                    Text(benchStatus(bench))
                        .font(.caption2)
                        .foregroundStyle(benchStatusColor(bench))
                        .lineLimit(1)

                    Spacer(minLength: 0)

                    Menu {
                        benchActionMenu(bench)
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .accessibilityLabel("Bench actions")
                    .disabled(viewModel.benchBusy)
                }

                pipelineBanner
            }
            .confirmationDialog(
                pipelineConfirmMessage,
                isPresented: $confirmPipelineAi,
                titleVisibility: .visible
            ) {
                Button("Resolve with AI") {
                    viewModel.confirmWorktreePipelineAi(repoPath: state.repoPath)
                }
                Button("Cancel", role: .cancel) {
                    viewModel.cancelWorktreePipeline(repoPath: state.repoPath)
                }
            }
            .onChange(of: pipelinePhase) { _, phase in
                // Raise the cost gate exactly when the pipeline stops at it —
                // the same moment the desktop's ConfirmDialog appears.
                confirmPipelineAi = phase == .awaitingAiConfirm
            }

            if isExpanded {
                if let terminalTab {
                    InboxBenchTerminalRow(tab: terminalTab)
                        .padding(.leading, IonSpace.sectionGap)
                }

                ForEach(conversationTabs) { tab in
                    benchConversationRow(tab, bench: bench)
                }
                if bench.lastAssemblyFailure == "verification", let evidence = bench.lastAssemblyVerification {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(evidence.command).font(.caption2.monospaced())
                        Text(evidence.outputTail).font(.caption2).lineLimit(4)
                    }
                    .foregroundStyle(.secondary)
                    .padding(.leading, IonSpace.sectionGap)
                }
            } else {
                ForEach(InboxNavigator.collapsedRows(occupants, activeTabId: activeTabId)) { tab in
                    if tab.id == terminalTab?.id {
                        InboxBenchTerminalRow(tab: tab)
                            .padding(.leading, IonSpace.sectionGap)
                    } else {
                        benchConversationRow(tab, bench: bench)
                    }
                }
            }
        }
    }

    // MARK: - Pipeline projection

    private var pipeline: RemoteWorktreePipeline? {
        viewModel.worktreePipelines[state.repoPath]
    }

    private var pipelinePhase: RemoteWorktreePipeline.Phase? {
        pipeline?.phase
    }

    private var pipelineRunning: Bool {
        guard let phase = pipelinePhase else { return false }
        return phase != .done && phase != .failed
    }

    private var pipelineConfirmMessage: String {
        let count = pipeline?.queue.count ?? 0
        let names = (pipeline?.queue ?? []).map { $0.split(separator: "/").last.map(String.init) ?? $0 }
        let list = names.isEmpty ? "" : ": \(names.joined(separator: ", "))"
        return "Resolve \(count) conflict\(count == 1 ? "" : "s") with AI\(list)? One agent runs at a time; recorded resolutions replay between agents."
    }

    /// The live pipeline banner — the same phases and wording the desktop's
    /// WorktreePipelinePanel shows, rendered from the pushed projection.
    @ViewBuilder
    private var pipelineBanner: some View {
        if let pipeline, let phase = pipeline.phase {
            HStack(spacing: 6) {
                switch phase {
                case .syncing, .resolving, .assembling:
                    ProgressView().controlSize(.mini)
                case .awaitingAiConfirm:
                    Image(systemName: "exclamationmark.triangle").foregroundStyle(.orange)
                case .done:
                    Image(systemName: "checkmark.circle").foregroundStyle(.green)
                case .failed:
                    Image(systemName: "xmark.circle").foregroundStyle(.red)
                }
                Text(pipelineBannerText(pipeline, phase: phase))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                Spacer(minLength: 0)
                if phase == .done || phase == .failed {
                    Button {
                        viewModel.dismissWorktreePipeline(repoPath: state.repoPath)
                    } label: {
                        Image(systemName: "xmark").font(.caption2)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Dismiss pipeline result")
                } else if phase != .awaitingAiConfirm {
                    Button("Cancel") {
                        viewModel.cancelWorktreePipeline(repoPath: state.repoPath)
                    }
                    .font(.caption2)
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private func pipelineBannerText(_ pipeline: RemoteWorktreePipeline, phase: RemoteWorktreePipeline.Phase) -> String {
        switch phase {
        case .syncing: return "Syncing worktrees from source…"
        case .awaitingAiConfirm: return "Waiting for confirmation"
        case .resolving:
            let name = pipeline.current?.split(separator: "/").last.map(String.init) ?? "conflict"
            let done = pipeline.resolvedByAi
            let total = done + pipeline.queue.count
            return "Resolving \(name) (\(min(done + 1, max(total, 1)))/\(max(total, 1)))…"
        case .assembling: return "Updating bench…"
        case .done, .failed: return pipeline.summary ?? (phase == .done ? "Done" : "Failed")
        }
    }

    private func benchConversationRow(_ tab: RemoteTabState, bench: RemoteBench) -> some View {
        row(tab)
            .padding(.leading, IonSpace.sectionGap)
            .overlay(alignment: .trailing) {
                if tab.id == bench.activeAutoFixTabId {
                    Image(systemName: "bolt.fill")
                        .font(.caption2)
                        .foregroundStyle(.orange)
                        .symbolEffect(.variableColor.iterative, value: tab.id == bench.activeAutoFixTabId)
                        .accessibilityLabel("Auto-fix active")
                }
            }
    }

    /// The bench header's one-line status. The wording and the rules live in
    /// `BenchAssemblyTime.summary`, which mirrors the desktop's
    /// `benchMemberSummary` — a failed assembly still replaces everything,
    /// because the bench is empty and member freshness is not the operator's
    /// problem yet.
    private func benchStatus(_ bench: RemoteBench) -> String {
        if bench.lastAssembly == "failed" {
            return bench.lastAssemblyFailure == "verification" ? "Verification failed" : "Assembly failed"
        }
        return BenchAssemblyTime.summary(
            total: state.memberCount(of: bench),
            behind: state.behindMemberCount(of: bench),
            lastBuiltAtMs: bench.lastBuiltAt,
        )
    }

    private func benchStatusColor(_ bench: RemoteBench) -> Color {
        if bench.lastAssembly == "failed" { return .red }
        if state.behindMemberCount(of: bench) > 0 { return .orange }
        return .secondary
    }

    @ViewBuilder
    private func benchActionMenu(_ bench: RemoteBench) -> some View {
        Button("Open Bench Conversation") {
            viewModel.openBenchConversation(repoPath: state.repoPath, sourceBranch: bench.sourceBranch)
        }
        Button("Open Bench Terminal") {
            openBenchTerminal(bench)
        }
        Button("Sync worktree pipeline") {
            viewModel.startWorktreePipeline(repoPath: state.repoPath, sourceBranch: bench.sourceBranch)
        }
        Button("Re-sync (mechanical only)") {
            viewModel.syncAllWorktrees(repoPath: state.repoPath)
        }
        Button("Assemble") {
            viewModel.assembleBench(repoPath: state.repoPath, sourceBranch: bench.sourceBranch)
        }
        Button("Update all & assemble") {
            viewModel.updateAllBenchMembers(repoPath: state.repoPath, sourceBranch: bench.sourceBranch)
        }
        Button("Recover conflict") {
            viewModel.recoverBenchConflict(repoPath: state.repoPath, sourceBranch: bench.sourceBranch)
        }
        Button("Resolve conflict with AI") {
            viewModel.benchConflictAssist(repoPath: state.repoPath, sourceBranch: bench.sourceBranch)
        }
        Button("Open verification analysis") {
            viewModel.analyseBenchVerification(repoPath: state.repoPath, sourceBranch: bench.sourceBranch)
        }
        Button("Delete replay cache", role: .destructive) {
            viewModel.discardAllBenchRecordings(repoPath: state.repoPath, sourceBranch: bench.sourceBranch)
        }
    }

    private func openBenchTerminal(_ bench: RemoteBench) {
        if let terminalTabId = bench.benchTerminalTabId {
            viewModel.navigateToTab(terminalTabId)
        } else {
            viewModel.openBenchTerminal(repoPath: state.repoPath, sourceBranch: bench.sourceBranch)
        }
    }

    private func cycleBenchConversation(_ bench: RemoteBench) {
        guard let next = InboxNavigator.nextBenchConversation(bench.openConversations, currentTabId: activeTabId) else {
            // No conversation yet: the tap opens the persistent operator
            // singleton, exactly like the desktop bar's cursor-gated click.
            viewModel.openBenchConversation(repoPath: state.repoPath, sourceBranch: bench.sourceBranch)
            return
        }
        viewModel.navigateToTab(next.tabId)
    }

    private func toggle(_ key: String) {
        if expanded.contains(key) { expanded.remove(key) } else { expanded.insert(key) }
    }
}

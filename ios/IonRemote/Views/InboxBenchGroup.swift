import SwiftUI

/// Bench assembly-age wording, shared with tests. Non-generic namespace so
/// callers do not have to name InboxBenchGroup's Row parameter.
enum BenchAssemblyTime {
    /// "assembled 5m ago", matching the desktop's wording (both BenchBar.tsx and
    /// InboxBenchBar.tsx) so the two clients never disagree on how bench age
    /// reads. `lastBuiltAt` is Unix ms; 0 means never assembled. `now` is the
    /// moment the age is measured from.
    static func relative(_ lastBuiltAtMs: Double, now: Date = Date()) -> String {
        guard lastBuiltAtMs > 0 else { return "never assembled" }
        let date = Date(timeIntervalSince1970: lastBuiltAtMs / 1000)
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return "assembled \(formatter.localizedString(for: date, relativeTo: now))"
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
    /// The status line while a conflict-resolution merge is open in the bench.
    /// Mirrors the desktop's `benchResolutionOpenSummary`. It replaces every
    /// other status: nothing assembles until the merge is continued or aborted.
    static func resolutionOpenSummary(unmergedPaths: Int) -> String {
        if unmergedPaths == 0 { return "Merge open · ready to continue" }
        return "Merge open · \(unmergedPaths) conflicted file\(unmergedPaths == 1 ? "" : "s")"
    }

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
    @Environment(\.appTheme) private var theme
    let state: RemoteWorktreeState
    let tabsByBenchPath: [String: [RemoteTabState]]
    let terminalTabsByID: [String: RemoteTabState]
    /// Full-featured inbox conversation row (same builder as worktree groups).
    @ViewBuilder let row: (RemoteTabState) -> Row
    @State private var confirmPipelineAi = false
    /// The source branch whose verification sheet is open, if any.
    @State private var verificationSheetBranch: String?

    var body: some View {
        ForEach(state.benches) { bench in
            let benchTabs = tabsByBenchPath[bench.benchPath] ?? []
            let conversationTabs = benchTabs.filter { $0.id != bench.benchTerminalTabId }
            let terminalTab = bench.benchTerminalTabId.flatMap { terminalTabsByID[$0] }
            VStack(alignment: .leading, spacing: IonSpace.hairlineGap) {
                // Line one: the header itself, with its two actions on the
                // trailing edge. Conversation count uses the role-inclusive
                // list; an empty bench omits it.
                HStack(spacing: 0) {
                    // The bench does not collapse: while its project is open
                    // its terminal and conversations are always listed, so the
                    // header has no chevron. Its tap opens the bench terminal,
                    // because building and testing the assembled stack is what
                    // the bench is for. The bench conversation lives in the
                    // overflow menu.
                    Button {
                        openBenchTerminal(bench)
                    } label: {
                        InboxDisclosureHeader(
                            title: "Bench · \(bench.sourceBranch)",
                            systemImage: "flask",
                            count: bench.openConversations.count,
                            isExpanded: true,
                            showsChevron: false
                        ) {
                            // A healthy bench says its state quietly on the
                            // header line. Anything that needs attention gets
                            // the line below instead, in its status colour.
                            if !benchNeedsAttention(bench) {
                                Text(benchStatus(bench))
                                    .font(IonType.microLabel)
                                    .foregroundStyle(theme.textTertiary)
                                    .lineLimit(1)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint(bench.benchTerminalTabId == nil ? "Open bench terminal" : "Go to bench terminal")
                    .contextMenu {
                        benchActionMenu(bench)
                    }
                    Button {
                        // The desktop's Sync All is the full pipeline with the
                        // AI cost gate — not the mechanical-only bulk sync.
                        Haptic.light()
                        viewModel.startWorktreePipeline(repoPath: state.repoPath, sourceBranch: bench.sourceBranch)
                    } label: {
                        // While anything is in flight on this repository the
                        // glyph gives way to a spinner in the same slot.
                        if actionsLocked {
                            ProgressView()
                                .controlSize(.small)
                                .frame(width: Self.actionSize, height: InboxLayout.minHeight(.groupHeader))
                        } else {
                            headerGlyph("arrow.triangle.2.circlepath")
                        }
                    }
                    .buttonStyle(.plain)
                    .disabled(actionsLocked)
                    .accessibilityLabel(actionsLocked ? "Syncing" : "Sync all worktrees")
                    Menu {
                        benchActionMenu(bench)
                    } label: {
                        headerGlyph("ellipsis")
                    }
                    .accessibilityLabel("Bench actions")
                    .disabled(actionsLocked)
                    .opacity(actionsLocked ? 0.4 : 1)
                }

                // The bench is a sibling group to worktrees, not a child
                // action list, so a state that needs the operator stays in the
                // header where it is visible while the group is collapsed.
                if benchNeedsAttention(bench) {
                    Text(benchStatus(bench))
                        .font(IonType.microLabel)
                        .foregroundStyle(benchStatusColor(bench))
                        .lineLimit(1)
                        .padding(.leading, InboxLayout.chevronColumn + InboxLayout.iconColumn + IonSpace.compactInset * 2)
                }

                pipelineBanner
                    .padding(.leading, InboxLayout.chevronColumn + InboxLayout.iconColumn + IonSpace.compactInset * 2)
            }
            .inboxRow(level: 1, kind: .groupHeader)
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

            if let terminalTab {
                InboxBenchTerminalRow(tab: terminalTab)
                    .inboxRow(level: 2)
            }
            ForEach(conversationTabs) { tab in
                benchConversationRow(tab, bench: bench)
            }
            if bench.lastAssemblyFailure == "verification", let evidence = bench.lastAssemblyVerification {
                // What happened in words, and a tap to the ways out. The raw
                // verify output stays in the sheet, behind a disclosure.
                Button {
                    verificationSheetBranch = bench.sourceBranch
                } label: {
                    HStack(spacing: IonSpace.contentGap) {
                        Text(BenchVerificationCopy.headline(replayedBranches: evidence.replayedBranches))
                            .font(IonType.metadata)
                            .foregroundStyle(theme.textSecondary)
                            .multilineTextAlignment(.leading)
                            .lineLimit(3)
                        Spacer(minLength: IonSpace.hairlineGap)
                        Text("Fix")
                            .font(IonType.meaning)
                            .foregroundStyle(theme.accent)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint("Shows what failed and how to fix it")
                .inboxRow(level: 2)
                .sheet(isPresented: verificationSheetBinding(bench)) {
                    BenchVerificationSheet(repoPath: state.repoPath, sourceBranch: bench.sourceBranch)
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

    /// The tap target width of a bench header action: the touch minimum.
    private static var actionSize: CGFloat { IonSpace.Metric.standardRowHeight }

    /// A worktree or bench action is in flight on this repository, so every
    /// action here is held until it finishes.
    private var actionsLocked: Bool {
        viewModel.worktreeActionsLocked(repoPath: state.repoPath)
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
                    Image(systemName: "exclamationmark.triangle").foregroundStyle(theme.statusWarning)
                case .done:
                    Image(systemName: "checkmark.circle").foregroundStyle(theme.statusDone)
                case .failed:
                    Image(systemName: "xmark.circle").foregroundStyle(theme.statusError)
                }
                Text(pipelineBannerText(pipeline, phase: phase))
                    .font(IonType.microLabel)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                Spacer(minLength: 0)
                if phase == .done || phase == .failed {
                    Button {
                        viewModel.dismissWorktreePipeline(repoPath: state.repoPath)
                    } label: {
                        Image(systemName: "xmark").font(IonType.microLabel)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Dismiss pipeline result")
                } else if phase != .awaitingAiConfirm {
                    Button("Cancel") {
                        viewModel.cancelWorktreePipeline(repoPath: state.repoPath)
                    }
                    .font(IonType.microLabel)
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
            .overlay(alignment: .topTrailing) {
                if tab.id == bench.activeAutoFixTabId {
                    Image(systemName: "bolt.fill")
                        .font(IonType.microLabel)
                        .foregroundStyle(theme.statusWarning)
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
        if let open = bench.resolutionOpen {
            return BenchAssemblyTime.resolutionOpenSummary(unmergedPaths: open.unmergedPaths)
        }
        if bench.lastAssembly == "failed" {
            return bench.lastAssemblyFailure == "verification" ? "Verification failed" : "Assembly failed"
        }
        return BenchAssemblyTime.summary(
            total: state.memberCount(of: bench),
            behind: state.behindMemberCount(of: bench),
            lastBuiltAtMs: bench.lastBuiltAt,
        )
    }

    /// Whether the bench's state is one the operator should act on: an open
    /// merge, a failed assembly, or members out of date.
    private func benchNeedsAttention(_ bench: RemoteBench) -> Bool {
        bench.resolutionOpen != nil || bench.lastAssembly == "failed" || state.behindMemberCount(of: bench) > 0
    }

    private func benchStatusColor(_ bench: RemoteBench) -> Color {
        if bench.resolutionOpen != nil { return theme.statusWarning }
        if bench.lastAssembly == "failed" { return theme.statusError }
        if state.behindMemberCount(of: bench) > 0 { return theme.statusWarning }
        return theme.textTertiary
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

    private func verificationSheetBinding(_ bench: RemoteBench) -> Binding<Bool> {
        Binding(
            get: { verificationSheetBranch == bench.sourceBranch },
            set: { if !$0 { verificationSheetBranch = nil } }
        )
    }

    private func openBenchTerminal(_ bench: RemoteBench) {
        if let terminalTabId = bench.benchTerminalTabId {
            viewModel.navigateToTab(terminalTabId)
        } else {
            viewModel.openBenchTerminal(repoPath: state.repoPath, sourceBranch: bench.sourceBranch)
        }
    }

    /// A header action glyph: one size, one tap target, for every action on
    /// the bench header's trailing edge.
    private func headerGlyph(_ systemName: String) -> some View {
        Image(systemName: systemName)
            .font(IonType.meaning)
            .foregroundStyle(theme.textSecondary)
            .frame(width: Self.actionSize, height: InboxLayout.minHeight(.groupHeader))
            .contentShape(Rectangle())
    }
}

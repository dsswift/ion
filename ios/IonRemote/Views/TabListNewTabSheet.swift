import SwiftUI

// MARK: - "New Tab" bottom sheet
//
// Extracted from TabListView.swift to keep that file under the 600-line
// Swift cap (CLAUDE.md → "When a file exceeds the cap"). The sheet shows a
// list of recent / default-base directories and offers two creation
// modes per row (conversation + optional profile routing, and terminal).
//
// Post-#256: the separate engine bolt button is gone. "New Conversation"
// (the plain `+` button) now routes through `resolveNewConversationAction`
// in the caller (TabListView) and creates either a plain tab, a profiled
// engine tab, or presents the profile picker — all without a separate
// "New Engine" affordance. The terminal button is unchanged.
//
// `pendingPinToGroupId` is the wiring for the per-group "+" button feature:
// when the sheet is presented from a group header's `+` (instead of the
// global toolbar `+`), the caller sets this to the target group's id; we
// forward it as `pinToGroupId` on the createTab command so the desktop
// places the new tab inside that group with groupPinned=true from the
// start, suppressing the first-prompt auto-movement that would otherwise
// yank the tab away from the user's explicit group choice.
struct TabListNewTabSheet: View {
    @Environment(SessionViewModel.self) private var viewModel
    let directories: [(label: String, fullPath: String)]
    let pendingPinToGroupId: String?
    @Binding var isPresented: Bool
    /// Called when the user taps the "New Conversation" (+) button for a
    /// directory. The caller applies `resolveNewConversationAction` routing
    /// and creates the tab (plain or profiled) or shows the profile picker.
    let onNewConversation: (_ dir: String, _ pinToGroupId: String?) -> Void
    let onCreateTerminalTab: (_ dir: String) -> Void

    var body: some View {
        NavigationStack {
            List {
                // Worktrees + benches first. This is the ZERO-KNOWLEDGE
                // recovery path: closing a worktree conversation no longer
                // destroys anything, but the operator still needs a way back in
                // without knowing a generated ~/.ion/worktrees/... path -- and
                // on iOS the git pane is two navigations away, so it cannot be
                // the only route.
                worktreeSections

                Section("Directories") {
                ForEach(directories, id: \.fullPath) { dir in
                    HStack {
                        Text(dir.label)
                            .lineLimit(1)
                        Spacer()
                        // New Conversation: routes through smart picker in caller.
                        Button {
                            isPresented = false
                            onNewConversation(dir.fullPath, pendingPinToGroupId)
                        } label: {
                            Image(systemName: "plus")
                        }
                        .buttonStyle(.bordered)
                        .buttonBorderShape(.circle)
                        // Terminal: unchanged.
                        Button {
                            isPresented = false
                            onCreateTerminalTab(dir.fullPath)
                        } label: {
                            Image(systemName: "terminal")
                        }
                        .buttonStyle(.bordered)
                        .buttonBorderShape(.circle)
                    }
                }
                }
            }
            .navigationTitle(pendingPinToGroupId == nil ? "New Tab" : "New Tab in Group")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { isPresented = false }
                }
            }
        }
        .task { viewModel.refreshAllWorktrees() }
        .presentationDetents([.medium])
    }
}

extension TabListNewTabSheet {

    /// Bench and worktree rows, grouped per project.
    @ViewBuilder
    var worktreeSections: some View {
        ForEach(viewModel.worktreeProjects) { state in
            let builtBenches = state.benches.filter(\.hasBeenBuilt)
            if !builtBenches.isEmpty || !state.worktrees.isEmpty {
                Section(projectLabel(state.repoPath)) {
                    // Built bench exposes both singleton destinations: Talk for
                    // conversation context and Terminal for shell work.
                    ForEach(builtBenches) { bench in
                        HStack(spacing: 8) {
                            Image(systemName: "flask").foregroundStyle(.tint)
                            Text("Bench · \(bench.sourceBranch)").lineLimit(1)
                            Spacer()
                            ViewThatFits(in: .horizontal) {
                                HStack(spacing: 6) {
                                    benchAction(bench.benchConversationTabId == nil ? "Talk" : "Go to",
                                                icon: "bubble.left") {
                                        viewModel.openBenchConversation(repoPath: state.repoPath,
                                                                        sourceBranch: bench.sourceBranch)
                                    }
                                    benchAction("Terminal", icon: "terminal") {
                                        viewModel.openBenchTerminal(repoPath: state.repoPath,
                                                                    sourceBranch: bench.sourceBranch)
                                    }
                                }
                                HStack(spacing: 6) {
                                    benchAction(nil, icon: "bubble.left") {
                                        viewModel.openBenchConversation(repoPath: state.repoPath,
                                                                        sourceBranch: bench.sourceBranch)
                                    }
                                    benchAction(nil, icon: "terminal") {
                                        viewModel.openBenchTerminal(repoPath: state.repoPath,
                                                                    sourceBranch: bench.sourceBranch)
                                    }
                                }
                            }
                        }
                    }
                    ForEach(state.worktrees) { wt in
                        Button {
                            isPresented = false
                            viewModel.openWorktreeConversation(worktreePath: wt.worktreePath)
                        } label: {
                            HStack(spacing: 8) {
                                Image(systemName: "arrow.triangle.branch")
                                    .foregroundStyle(.green)
                                // Title-first, matching every other worktree
                                // surface on both clients.
                                Text(wt.displayName).lineLimit(1)
                                Spacer()
                                if wt.isDirty {
                                    Text("dirty").font(.caption2).foregroundStyle(.green)
                                }
                                if wt.needsSync {
                                    Text("base moved").font(.caption2).foregroundStyle(.orange)
                                }
                                if !wt.openConversations.isEmpty {
                                    Text("open").font(.caption2).foregroundStyle(.tint)
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func benchAction(_ title: String?, icon: String, action: @escaping () -> Void) -> some View {
        Button {
            isPresented = false
            action()
        } label: {
            if let title {
                Label(title, systemImage: icon).font(.caption)
            } else {
                Image(systemName: icon)
                    .font(.caption)
                    .accessibilityLabel(icon == "terminal" ? "Terminal" : "Talk")
            }
        }
        .buttonStyle(.bordered)
    }

    private func projectLabel(_ repoPath: String) -> String {
        repoPath.split(separator: "/").last.map(String.init) ?? repoPath
    }
}

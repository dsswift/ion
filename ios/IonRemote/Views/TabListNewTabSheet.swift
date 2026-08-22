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
    let onCreateWorktree: (_ repoPath: String, _ sourceBranch: String) -> Void
    let onCreateTerminalTab: (_ dir: String) -> Void

    var body: some View {
        NavigationStack {
            List {
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
                        if let sourceBranch = viewModel.worktreeStates[dir.fullPath]?.benches.first?.sourceBranch {
                            Button {
                                isPresented = false
                                onCreateWorktree(dir.fullPath, sourceBranch)
                            } label: {
                                Image(systemName: "arrow.triangle.branch")
                            }
                            .accessibilityLabel("Create worktree from \(sourceBranch)")
                            .buttonStyle(.bordered)
                            .buttonBorderShape(.circle)
                        }
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
        .presentationDetents([.medium])
    }
}

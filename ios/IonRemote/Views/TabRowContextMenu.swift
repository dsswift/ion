import SwiftUI

/// Context menu for tab rows in the tab list.
///
/// Extracted from `TabListView` to keep that file under the Swift 600-line
/// cap. See CLAUDE.md → "When a file exceeds the cap".
struct TabRowContextMenu: ViewModifier {
    let tab: RemoteTabState
    @Binding var renamingTabId: String?
    @Binding var renameText: String
    @Environment(SessionViewModel.self) private var viewModel

    /// The worktree this tab is running in, when it is one. Resolved from the
    /// desktop's projection rather than inferred from the path.
    private var worktreeForTab: (state: RemoteWorktreeState, worktree: RemoteWorktree)? {
        for state in viewModel.worktreeStates.values {
            if let wt = state.worktrees.first(where: { tab.workingDirectory == $0.worktreePath || tab.workingDirectory.hasPrefix($0.worktreePath + "/") }) {
                return (state, wt)
            }
        }
        return nil
    }

    func body(content: Content) -> some View {
        content.contextMenu {
            // -- Worktree actions --
            //
            // Surfaced HERE, not only in the git pane: on iOS the pane is two
            // navigations away, and these are the actions an operator reaches
            // for while scanning the tab list.
            if let (state, wt) = worktreeForTab {
                if !wt.isSealed {
                    Button {
                        viewModel.newWorktreeConversation(worktreePath: wt.worktreePath)
                    } label: {
                        Label("New conversation in this worktree", systemImage: "bubble.left.and.bubble.right")
                    }
                    if let source = wt.sourceBranch {
                        Button {
                            viewModel.syncWorktree(wt, repoPath: state.repoPath)
                        } label: {
                            Label("Sync from \(source)", systemImage: "arrow.triangle.pull")
                        }
                        .disabled(wt.isDirty)

                        // Same discard-covers-nothing-to-land rule as
                        // WorktreeRowView / desktop's canLandWorktree.
                        Button(role: wt.unlandedCommitCount == 0 ? .destructive : nil) {
                            viewModel.landAndRetireWorktree(wt, repoPath: state.repoPath)
                        } label: {
                            Label(
                                wt.unlandedCommitCount > 0
                                    ? "Land and retire into \(source)"
                                    : "Retire (nothing to land)",
                                systemImage: "arrow.down.to.line"
                            )
                        }
                        .disabled(wt.isDirty)
                    }
                }
                Divider()
            } else if viewModel.worktreeStates[tab.workingDirectory] != nil {
                Button {
                    viewModel.convertConversationToWorktree(tabId: tab.id)
                } label: {
                    Label("Move conversation into a worktree", systemImage: "arrow.triangle.branch")
                }
                Divider()
            }

            // -- Clipboard actions --
            ConversationClipboardActions(tab: tab)
            if tab.isTerminalOnly != true {
                Divider()
            }

            // -- Tab management --
            Button {
                renameText = tab.displayTitle
                renamingTabId = tab.id
            } label: {
                Label("Rename", systemImage: "pencil")
            }

            // -- Pill color --
            Menu("Color") {
                Button {
                    viewModel.setPillColor(tabId: tab.id, color: nil)
                } label: {
                    Label("Default", systemImage: "circle.slash")
                }
                pillColorButton(hex: "#f08c4a", label: "Orange", systemImage: "circle.fill")
                pillColorButton(hex: "#4ece78", label: "Green",  systemImage: "circle.fill")
                pillColorButton(hex: "#ef5350", label: "Red",    systemImage: "circle.fill")
                pillColorButton(hex: "#42a5f5", label: "Blue",   systemImage: "circle.fill")
                pillColorButton(hex: "#b06de8", label: "Purple", systemImage: "circle.fill")
                pillColorButton(hex: "#f5c842", label: "Gold",   systemImage: "circle.fill")
            }
        }
    }

    // MARK: - Pill helpers

    @ViewBuilder
    private func pillColorButton(hex: String, label: String, systemImage: String) -> some View {
        Button {
            viewModel.setPillColor(tabId: tab.id, color: hex)
        } label: {
            Label(label, systemImage: systemImage)
                .foregroundStyle(Color(hex: hex))
        }
    }
}

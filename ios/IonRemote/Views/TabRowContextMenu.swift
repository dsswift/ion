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

    /// Merges live `statusFields.sessionId` with historical `conversationIds`
    /// for the active engine instance. Returns all IDs (historical first,
    /// live appended if not already present). Matches the desktop
    /// SettingsPopover merge logic.
    private var engineSessionIds: [String] {
        guard tab.hasEngineExtension == true else { return [] }
        let instanceId = viewModel.activeEngineInstance[tab.id]
        let inst = viewModel.engineInstance(tabId: tab.id, instanceId: instanceId)
        let liveId = inst?.statusFields?.sessionId
        var ids = inst?.conversationIds ?? []
        if let current = liveId, !ids.contains(current) {
            ids.append(current)
        }
        return ids
    }

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
                if !wt.isLanded {
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
            if tab.hasEngineExtension == true {
                if !engineSessionIds.isEmpty {
                    Button {
                        UIPasteboard.general.string = engineSessionIds.joined(separator: "\n")
                        viewModel.showToast(ToastMessage(style: .success, title: "Session ID copied"))
                    } label: {
                        Label("Copy Session ID", systemImage: "doc.on.doc")
                    }
                    Divider()
                }
            } else if let conversationId = tab.conversationId, !conversationId.isEmpty {
                Button {
                    UIPasteboard.general.string = conversationId
                    viewModel.showToast(ToastMessage(style: .success, title: "Session ID copied"))
                } label: {
                    Label("Copy Session ID", systemImage: "doc.on.doc")
                }
                Divider()
            }

            // -- Tab management --
            Button {
                renameText = tab.displayTitle
                renamingTabId = tab.id
            } label: {
                Label("Rename", systemImage: "pencil")
            }

            // -- Pill appearance --
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
            Menu("Icon") {
                Button {
                    viewModel.setPillIcon(tabId: tab.id, icon: nil)
                } label: {
                    Label("Default", systemImage: "circle.fill")
                }
                pillIconButton(icon: "diamond",  label: "Diamond",  sfSymbol: "diamond.fill")
                pillIconButton(icon: "square",   label: "Square",   sfSymbol: "square.fill")
                pillIconButton(icon: "star",     label: "Star",     sfSymbol: "star.fill")
                pillIconButton(icon: "triangle", label: "Triangle", sfSymbol: "triangle.fill")
                pillIconButton(icon: "heart",    label: "Heart",    sfSymbol: "heart.fill")
                pillIconButton(icon: "hexagon",  label: "Hexagon",  sfSymbol: "hexagon.fill")
                pillIconButton(icon: "lightning",label: "Lightning",sfSymbol: "bolt.fill")
                pillIconButton(icon: "mobile",   label: "Mobile",   sfSymbol: "iphone")
                pillIconButton(icon: "desktop",  label: "Desktop",  sfSymbol: "desktopcomputer")
                pillIconButton(icon: "gear",     label: "Gear",     sfSymbol: "gearshape.fill")
            }

            // Pin/unpin and move-to-group-and-pin are irrelevant for
            // engine tabs — they are multiplexed (multiple sub-conversations)
            // and shouldn't auto-move between groups.
            if viewModel.tabGroupMode == "manual" && tab.hasEngineExtension != true {
                Button {
                    viewModel.toggleTabGroupPin(tabId: tab.id)
                } label: {
                    Label(
                        tab.groupPinned == true ? "Unpin from Group" : "Pin to Group",
                        systemImage: tab.groupPinned == true ? "pin.slash" : "pin"
                    )
                }
                let targets = viewModel.tabGroups.filter { $0.id != tab.groupId }
                if !targets.isEmpty {
                    Menu {
                        ForEach(targets) { target in
                            Button(target.label) {
                                viewModel.moveTabToGroup(tabId: tab.id, groupId: target.id)
                            }
                        }
                    } label: {
                        Label("Move to Group", systemImage: "arrow.right.arrow.left")
                    }
                    // Combined "Move to Group AND Pin": same target list as the
                    // plain "Move to Group" submenu above, but each selection
                    // routes through moveTabToGroupAndPin which also sets
                    // groupPinned=true so the destination tab is protected from
                    // any subsequent auto-group-movement. Mirrors the desktop
                    // pattern (TabStripTabContextMenu's PushPin row).
                    Menu {
                        ForEach(targets) { target in
                            Button(target.label) {
                                viewModel.moveTabToGroupAndPin(tabId: tab.id, groupId: target.id)
                            }
                        }
                    } label: {
                        Label("Move to Group and Pin", systemImage: "pin")
                    }
                }
            } else if viewModel.tabGroupMode == "manual" && tab.hasEngineExtension == true {
                // Engine tabs: allow plain move-to-group (manual
                // organization) but skip pin/unpin and move-and-pin.
                let targets = viewModel.tabGroups.filter { $0.id != tab.groupId }
                if !targets.isEmpty {
                    Menu {
                        ForEach(targets) { target in
                            Button(target.label) {
                                viewModel.moveTabToGroup(tabId: tab.id, groupId: target.id)
                            }
                        }
                    } label: {
                        Label("Move to Group", systemImage: "arrow.right.arrow.left")
                    }
                }
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

    @ViewBuilder
    private func pillIconButton(icon: String, label: String, sfSymbol: String) -> some View {
        Button {
            viewModel.setPillIcon(tabId: tab.id, icon: icon)
        } label: {
            Label(label, systemImage: sfSymbol)
        }
    }
}

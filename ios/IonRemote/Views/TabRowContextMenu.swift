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
        guard tab.isEngine == true else { return [] }
        let instanceId = viewModel.activeEngineInstance[tab.id]
        let inst = viewModel.engineInstance(tabId: tab.id, instanceId: instanceId)
        let liveId = inst?.statusFields?.sessionId
        var ids = inst?.conversationIds ?? []
        if let current = liveId, !ids.contains(current) {
            ids.append(current)
        }
        return ids
    }

    func body(content: Content) -> some View {
        content.contextMenu {
            // -- Clipboard actions --
            if tab.isEngine == true {
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
            if viewModel.tabGroupMode == "manual" && tab.isEngine != true {
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
            } else if viewModel.tabGroupMode == "manual" && tab.isEngine == true {
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

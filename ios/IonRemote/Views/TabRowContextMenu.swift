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

    func body(content: Content) -> some View {
        content.contextMenu {
            // -- Clipboard actions --
            if tab.isEngine == true {
                let compoundKey = viewModel.engineCompoundKey(tabId: tab.id)
                if let sessionId = viewModel.engineStatusFields[compoundKey]?.sessionId {
                    Button {
                        UIPasteboard.general.string = sessionId
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
}

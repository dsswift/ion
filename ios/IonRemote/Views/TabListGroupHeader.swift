import SwiftUI

// MARK: - Group header for tab list
//
// Extracted from TabListView.swift to keep that file under the 600-line
// Swift cap (CLAUDE.md → "When a file exceeds the cap"). Renders the
// section header for a tab group: chevron + label + (optional) per-group
// `+` button. The `+` button supports two interactions:
//
//   • Tap: opens the new-tab bottom sheet with `pendingPinToGroupId` set
//     so the sheet's "New Tab" action will stamp pinToGroupId on the
//     outbound createTab command. This is the fix for: per-group `+`
//     used to create tabs that the first prompt's auto-movement
//     immediately yanked into the planning group.
//
//   • Long press: shows a context menu with quick actions for creating
//     a new conversation tab (with pin), terminal tab, or engine tab in
//     this directory. The "New Tab" path is the only one currently
//     pinned-to-group — extending the same fix to "New Terminal" /
//     "New Engine" would require additive `pinToGroupId` fields on
//     `create_terminal_tab` / `create_engine_tab`, which are out of scope.

struct TabListGroupHeader: View {
    let group: (label: String, id: String, icon: String, directory: String?, tabs: [RemoteTabState])
    let isCollapsed: Bool
    let tabGroupMode: String
    @Binding var pendingPinToGroupId: String?
    @Binding var showNewTab: Bool
    let onCreateConversationTab: (_ dir: String, _ pinToGroupId: String?) -> Void
    let onCreateTerminalTab: (_ dir: String) -> Void
    let onCreateEngineTab: (_ dir: String) -> Void
    let onToggleCollapsed: () -> Void

    var body: some View {
        HStack {
            Image(systemName: "chevron.right")
                .font(.caption2.weight(.bold))
                .foregroundStyle(.tertiary)
                .rotationEffect(.degrees(isCollapsed ? 0 : 90))
            Label(group.label, systemImage: group.icon)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
            Spacer()
            if let dir = group.directory {
                Button {
                    // Per-group `+`: capture the group id so the sheet's
                    // "New Tab" action can stamp pinToGroupId on the
                    // outbound command, and the new tab will be born
                    // inside this group with groupPinned=true. Only
                    // applies when the desktop is in manual tab-group
                    // mode (otherwise the desktop-side handler ignores
                    // the field, but we still set it to mark intent).
                    pendingPinToGroupId = tabGroupMode == "manual" ? group.id : nil
                    showNewTab = true
                } label: {
                    Image(systemName: "plus")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .contextMenu {
                    Button {
                        // Long-press → "New Tab": same per-group
                        // semantics as the sheet path (above). When in
                        // manual group mode we forward pinToGroupId so
                        // the desktop creates the tab inside this group
                        // with groupPinned=true. The same fix would apply
                        // to "New Terminal" / "New Engine" below if
                        // their commands carried a pinToGroupId field —
                        // out of scope for the current bug report.
                        let pin = tabGroupMode == "manual" ? group.id : nil
                        onCreateConversationTab(dir, pin)
                    } label: {
                        Label("New Tab", systemImage: "plus")
                    }
                    Button {
                        onCreateTerminalTab(dir)
                    } label: {
                        Label("New Terminal", systemImage: "terminal")
                    }
                    Button {
                        onCreateEngineTab(dir)
                    } label: {
                        Label("New Engine", systemImage: "bolt.fill")
                    }
                }
            }
        }
        .padding(.top, 4)
        .contentShape(Rectangle())
        .onTapGesture {
            withAnimation(IonTheme.snappySpring) {
                onToggleCollapsed()
            }
        }
    }
}

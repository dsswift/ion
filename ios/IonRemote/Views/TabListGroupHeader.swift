import SwiftUI

// MARK: - Group header for tab list
//
// Extracted from TabListView.swift to keep that file under the 600-line
// Swift cap (CLAUDE.md → "When a file exceeds the cap"). Renders the
// section header for a tab group: chevron + label + (optional) per-group
// `+` button. The `+` button supports two interactions:
//
//   • Tap: opens the new-tab bottom sheet with `pendingPinToGroupId` set
//     so the sheet's "New Conversation" action will stamp pinToGroupId on
//     the outbound createTab command. This is the fix for: per-group `+`
//     used to create tabs that the first prompt's auto-movement
//     immediately yanked into the planning group.
//
//   • Long press: shows a context menu with quick actions for creating
//     a new conversation tab (with pin) or a terminal tab in this
//     directory. Post-#256: the separate "New Engine" context menu item
//     is gone — "New Tab" now routes through `onNewConversation` which
//     applies `resolveNewConversationAction` (plain/profile/picker).
//     Extending the group-pin fix to the context menu path would require
//     the caller to defer showing the picker until after setting
//     pendingPinToGroupId, which is out of scope for this change.

struct TabListGroupHeader: View {
    let group: (label: String, id: String, icon: String, directory: String?, tabs: [RemoteTabState])
    let isCollapsed: Bool
    let tabGroupMode: String
    @Binding var pendingPinToGroupId: String?
    @Binding var showNewTab: Bool
    /// Called when the user taps "New Tab" in the context menu (long press).
    /// Routes through `resolveNewConversationAction` in the caller.
    let onNewConversation: (_ dir: String, _ pinToGroupId: String?) -> Void
    let onCreateTerminalTab: (_ dir: String) -> Void
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
            // Group status rollup dot: highest-priority status across every tab
            // in the group. iOS parity surface for the desktop group-pill
            // GroupStatusDot (getGroupStatusColor). Sits on the trailing edge,
            // before the per-group `+` button.
            GroupStatusDot(status: TabStatusRollup.groupStatus(tabs: group.tabs))
            if let dir = group.directory {
                Button {
                    // Per-group `+`: capture the group id so the sheet's
                    // "New Conversation" action can stamp pinToGroupId on
                    // the outbound command, and the new tab will be born
                    // inside this group with groupPinned=true.
                    pendingPinToGroupId = tabGroupMode == "manual" ? group.id : nil
                    showNewTab = true
                } label: {
                    Image(systemName: "plus")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .contextMenu {
                    Button {
                        // Long-press → "New Tab": per-group semantics.
                        let pin = tabGroupMode == "manual" ? group.id : nil
                        onNewConversation(dir, pin)
                    } label: {
                        Label("New Tab", systemImage: "plus")
                    }
                    Button {
                        onCreateTerminalTab(dir)
                    } label: {
                        Label("New Terminal", systemImage: "terminal")
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

// MARK: - GroupStatusDot
//
// Renders the group's rolled-up status as a 6pt dot (matching the desktop's
// 6px group-pill dot). Pulses for the running / running-children states and
// applies a colored glow for the states that carry one on desktop. The idle
// state renders a dimmed gray dot (0.4 opacity) with no pulse and no glow so
// an all-idle group shows a quiet marker rather than clutter.

struct GroupStatusDot: View {
    let status: GroupTabStatus

    @State private var pulseOpacity: Double = 1.0

    /// Idle is the only non-glowing, non-pulsing state — render it dimmed.
    private var isIdle: Bool {
        status.priority == TabStatusRollup.priorityIdle
    }

    var body: some View {
        Circle()
            .fill(status.color)
            .frame(width: 6, height: 6)
            .opacity(dotOpacity)
            .shadow(color: status.glow ? status.glowColor.opacity(0.7) : .clear, radius: status.glow ? 3 : 0)
            .onChange(of: status.shouldPulse) { _, shouldPulse in
                applyPulse(shouldPulse)
            }
            .onAppear {
                applyPulse(status.shouldPulse)
            }
    }

    /// Idle dims to 0.4; a pulsing dot animates its opacity between full and
    /// 0.3; everything else renders at full opacity.
    private var dotOpacity: Double {
        if isIdle { return 0.4 }
        return status.shouldPulse ? pulseOpacity : 1.0
    }

    private func applyPulse(_ shouldPulse: Bool) {
        if shouldPulse {
            withAnimation(.easeInOut(duration: 1.5).repeatForever(autoreverses: true)) {
                pulseOpacity = 0.3
            }
        } else {
            withAnimation(.default) {
                pulseOpacity = 1.0
            }
        }
    }
}

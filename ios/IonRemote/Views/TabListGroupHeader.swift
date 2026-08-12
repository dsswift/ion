import SwiftUI

// MARK: - Group header for tab list
//
// Extracted from TabListView.swift to keep that file under the 600-line
// Swift cap (CLAUDE.md → "When a file exceeds the cap"). Renders the
// section header for a tab group: a chevron, the group label, and the
// rolled-up status dot when the group is not idle.
//
// Interactions:
//
//   • Tap: collapse / expand the group.
//
//   • Long press: a context menu with quick actions for creating a new
//     conversation tab (pinned to this group) or a terminal tab in this
//     directory. Post-#256 the separate "New Engine" item is gone — "New Tab"
//     routes through `onNewConversation`, which applies
//     `resolveNewConversationAction` (plain/profile/picker).
//
// The header previously carried its own `+` button (and the
// `pendingPinToGroupId` / `showNewTab` bindings that drove the bottom sheet).
// Both were removed in the restraint pass: a live button inside a section
// header competes with the rows it labels, and the long-press menu already
// offered the same two actions with the correct per-group pin semantics. The
// nav-bar `+` still covers creating a tab in the default directory, and the
// bottom sheet's `pendingPinToGroupId` wiring remains in use by TabListView
// for that path.

struct TabListGroupHeader: View {
    @Environment(\.appTheme) private var theme
    let group: (label: String, id: String, icon: String, directory: String?, tabs: [RemoteTabState])
    let isCollapsed: Bool
    let tabGroupMode: String
    /// Called when the user taps "New Tab" in the context menu (long press).
    /// Routes through `resolveNewConversationAction` in the caller.
    let onNewConversation: (_ dir: String, _ pinToGroupId: String?) -> Void
    let onCreateTerminalTab: (_ dir: String) -> Void
    let onToggleCollapsed: () -> Void

    /// The group's rolled-up status, folded once per render.
    private var rollup: GroupTabStatus {
        TabStatusRollup.groupStatus(tabs: group.tabs)
    }

    var body: some View {
        HStack(spacing: 6) {
            // The chevron is the only always-visible control in the strip. The
            // per-group `+` moved into the long-press context menu below: a
            // section header that carries a live button competes with the rows
            // it labels, and the same two actions stay one long press away.
            Image(systemName: "chevron.right")
                .font(.caption2)
                .foregroundStyle(theme.textTertiary)
                .rotationEffect(.degrees(isCollapsed ? 0 : 90))
            // Plain text, not a Label: the group icon restated what the label
            // already says. `.textCase(nil)` defeats the List section header's
            // default uppercasing so group names read as written.
            Text(group.label)
                .font(.footnote.weight(.medium))
                .foregroundStyle(theme.textTertiary)
                .textCase(nil)
            Spacer()
            // Group status rollup dot: highest-priority status across every tab
            // in the group. iOS parity surface for the desktop group-pill
            // GroupStatusDot (getGroupStatusColor).
            //
            // Hidden when the group folds to idle — the same rule the per-tab
            // dot follows. A dot that is always present carries no information
            // in a list where most groups are quiet; suppressing the idle case
            // is what makes the remaining dots mean "look here". Every
            // actionable state (error, permission, running, running-children,
            // background shells, plan-ready, question) still renders.
            if rollup.priority != TabStatusRollup.priorityIdle {
                GroupStatusDot(status: rollup)
            }
        }
        .padding(.top, IonSpace.hairlineGap)
        .contentShape(Rectangle())
        .onTapGesture {
            withAnimation(IonTheme.snappySpring) {
                onToggleCollapsed()
            }
        }
        // Long press is now the only path to the per-group create actions. The
        // menu is attached to the whole header strip rather than to a `+`
        // button, so the target is the full row width.
        .contextMenu {
            if let dir = group.directory {
                Button {
                    // Per-group semantics: stamp pinToGroupId so the new tab is
                    // born inside this group with groupPinned=true, rather than
                    // being yanked away by the first prompt's auto-movement.
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

    @Environment(\.appTheme) private var theme
    @State private var pulseOpacity: Double = 1.0

    /// Idle is the only non-glowing, non-pulsing state — render it dimmed.
    private var isIdle: Bool {
        status.priority == TabStatusRollup.priorityIdle
    }

    var body: some View {
        Circle()
            .fill(status.state.color(theme))
            .frame(width: 6, height: 6)
            .opacity(dotOpacity)
            .onChange(of: status.state.breathes) { _, shouldPulse in
                applyPulse(shouldPulse)
            }
            .onAppear {
                applyPulse(status.state.breathes)
            }
    }

    /// Idle dims to 0.4; a pulsing dot animates its opacity between full and
    /// 0.3; everything else renders at full opacity.
    private var dotOpacity: Double {
        if isIdle { return 0.4 }
        return status.state.breathes ? pulseOpacity : 1.0
    }

    private func applyPulse(_ shouldPulse: Bool) {
        if shouldPulse {
            withAnimation(.easeInOut(duration: 1.5).repeatForever(autoreverses: true)) {
                pulseOpacity = 0.35
            }
        } else {
            withAnimation(.default) {
                pulseOpacity = 1.0
            }
        }
    }
}

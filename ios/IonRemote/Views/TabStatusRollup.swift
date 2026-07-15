import SwiftUI

// MARK: - Group / per-tab status rollup
//
// Single source of truth for the tab status-dot cascade on iOS. Both the
// per-tab dot (`TabRowView.statusInfo`) and the group-header rollup dot
// (`TabListGroupHeader` → `GroupStatusDot`) fold this one classifier, exactly
// as the desktop folds `getTabStatusColor` for both the per-tab dot and the
// group pill (`getGroupStatusColor` in TabStripGroupStatus.ts). Keeping a
// single classifier is what stops the two surfaces from drifting.
//
// ─── Priority cascade (mirrors desktop TabStripGroupStatus.ts) ──────────────
//
//   8 = error            (dead/failed — red)
//   7 = permission       (generic tool permission — orange glow)
//   6 = running          (running/connecting — orange pulse)
//   5 = running-children (background agents — yellow pulse)
//   4 = plan-ready       (ExitPlanMode denial — green glow)
//   3 = question         (AskUserQuestion denial — blue glow)
//   2 = bash             (desktop-only — see note)
//   1 = unread           (desktop-only — see note)
//   0 = idle             (gray, dimmed)
//
// The numeric priorities are kept identical to the desktop constants so the
// fold ranks the same way on both clients. Levels 2 (bash) and 1 (unread) are
// intentionally UNREACHABLE on iOS: the desktop→iOS wire (RemoteTabState in
// desktop/src/main/remote/protocol.ts) does not project `bashExecuting` or
// `hasUnread` — those are desktop-renderer-only `TabState` fields. If either is
// ever added to the wire and to `RemoteTabState.swift`, its branch slots into
// the existing numeric gap without renumbering anything else.
//
// iOS wire nuance vs. desktop: on the desktop, ExitPlanMode / AskUserQuestion
// denials live on a separate `permissionDenied` field while `permissionQueue`
// holds only generic tool-permission requests. On iOS the snapshot merges all
// of them into `permissionQueue`, tagged by `toolName`. So the iOS classifier
// distinguishes them by tool name: `ExitPlanMode` → plan-ready, `AskUserQuestion`
// → question, anything else → generic permission.

/// The highest-priority status info for a tab (or a group of tabs). `priority`
/// drives the group fold (higher wins); `color` / `shouldPulse` / `glow` /
/// `glowColor` drive rendering.
struct GroupTabStatus: Equatable {
    let priority: Int
    let color: Color
    let shouldPulse: Bool
    let glow: Bool
    let glowColor: Color
}

enum TabStatusRollup {
    // ─── Priority constants (mirror desktop) ─────────────────────────────────
    static let priorityError = 8
    static let priorityPermission = 7
    static let priorityRunning = 6
    static let priorityChildren = 5
    static let priorityPlanReady = 4
    static let priorityQuestion = 3
    // 2 = bash and 1 = unread are desktop-only (not on the iOS wire).
    static let priorityIdle = 0

    // ─── Palette (hexes match TabRowView.statusInfo / desktop theme) ─────────
    static let errorColor = Color(hex: 0xC47060)
    static let permissionOrange = Color(hex: 0xE8854A)
    static let childrenYellow = Color(hex: 0xF59E0B)
    static let questionBlue = Color(hex: 0x4A9EF5)
    static let idleGray = Color(hex: 0x8A8A80)

    /// Classify a single tab into its status info. This is the exact cascade
    /// `TabRowView.statusInfo` renders — that computed property delegates here
    /// so there is one implementation, not two.
    static func classify(_ tab: RemoteTabState) -> GroupTabStatus {
        // 1. Dead / failed → red (no pulse, no glow).
        if tab.status == .dead || tab.status == .failed {
            return GroupTabStatus(
                priority: priorityError,
                color: errorColor,
                shouldPulse: false,
                glow: false,
                glowColor: errorColor
            )
        }

        // Partition the permission queue by tool name. On iOS all denial /
        // permission signals arrive here (see file header).
        let hasGenericPermission = tab.permissionQueue.contains {
            $0.toolName != "ExitPlanMode" && $0.toolName != "AskUserQuestion"
        }
        let hasPlanReady = tab.permissionQueue.contains { $0.toolName == "ExitPlanMode" }
        let hasQuestion = tab.permissionQueue.contains { $0.toolName == "AskUserQuestion" }

        // 2. Generic tool permission → orange glow (blocked, steady).
        if hasGenericPermission {
            return GroupTabStatus(
                priority: priorityPermission,
                color: permissionOrange,
                shouldPulse: false,
                glow: true,
                glowColor: permissionOrange
            )
        }

        // 3. Running / connecting → orange pulse (foreground active). Wins over
        //    the passive plan/question waits below.
        if tab.status == .running || tab.status == .connecting {
            return GroupTabStatus(
                priority: priorityRunning,
                color: permissionOrange,
                shouldPulse: true,
                glow: true,
                glowColor: permissionOrange
            )
        }

        // 4. Awaiting children → yellow pulse (orchestrator idle, background
        //    agents still executing). Outranks plan-ready: active background
        //    work is a stronger signal than a passive "waiting on you" state.
        //    This is the b8e21298 ordering — running-children beats plan-ready.
        if tab.hasRunningChildren == true {
            return GroupTabStatus(
                priority: priorityChildren,
                color: childrenYellow,
                shouldPulse: true,
                glow: true,
                glowColor: childrenYellow
            )
        }

        // 5. Plan ready → green glow (ExitPlanMode denial, run idle/completed).
        if hasPlanReady && (tab.status == .idle || tab.status == .completed) {
            return GroupTabStatus(
                priority: priorityPlanReady,
                color: .green,
                shouldPulse: false,
                glow: true,
                glowColor: .green
            )
        }

        // 6. Question pending → blue glow (AskUserQuestion denial).
        if hasQuestion && (tab.status == .idle || tab.status == .completed) {
            return GroupTabStatus(
                priority: priorityQuestion,
                color: questionBlue,
                shouldPulse: false,
                glow: true,
                glowColor: questionBlue
            )
        }

        // 7. Idle → dimmed gray (no pulse, no glow).
        return GroupTabStatus(
            priority: priorityIdle,
            color: idleGray,
            shouldPulse: false,
            glow: false,
            glowColor: idleGray
        )
    }

    /// Fold `classify` across a group's tabs and return the highest-priority
    /// status. Terminal-only tabs are excluded (they carry no conversation
    /// status), matching the desktop `getGroupStatusColor` filter. An empty or
    /// all-terminal group returns idle.
    static func groupStatus(tabs: [RemoteTabState]) -> GroupTabStatus {
        var best = GroupTabStatus(
            priority: priorityIdle,
            color: idleGray,
            shouldPulse: false,
            glow: false,
            glowColor: idleGray
        )
        for tab in tabs where tab.isTerminalOnly != true {
            let status = classify(tab)
            if status.priority > best.priority {
                best = status
            }
        }
        return best
    }
}

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
//   9 = error            (dead/failed — red)
//   8 = permission       (generic tool permission — orange glow)
//   7 = running          (running/connecting — teal pulse)
//   6 = running-children (background agents — yellow pulse)
//   5 = bash-background  (background shell commands — pink pulse)
//   4 = plan-ready       (ExitPlanMode denial — green glow)
//   3 = question         (AskUserQuestion denial — purple glow)
//   2 = bash             (user-typed `!` command — desktop-only, see note)
//   1 = unread           (desktop-only — see note)
//   0 = idle             (gray, dimmed)
//
// The numeric priorities are kept identical to the desktop constants so the
// fold ranks the same way on both clients. When the desktop renumbers its
// tiers, these renumber in lockstep — otherwise the two folds silently
// disagree on a tab that matches two states at once.
//
// Level 5 (bash-background) IS reachable: the desktop projects
// `backgroundShellCount` onto RemoteTabState, so a session holding for
// background bash commands renders the pink dot here exactly as it does on the
// desktop. Levels 2 (user-typed `!` bash) and 1 (unread) remain UNREACHABLE on
// iOS: the wire carries neither `bashExecuting` nor `hasUnread`, which are
// desktop-renderer-only `TabState` fields. If either is ever added to the wire
// and to `RemoteTabState.swift`, its branch slots into the existing numeric gap
// without renumbering anything else.
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
    static let priorityError = 9
    static let priorityPermission = 8
    static let priorityRunning = 7
    static let priorityChildren = 6
    static let priorityBashBackground = 5
    static let priorityPlanReady = 4
    static let priorityQuestion = 3
    // 2 = user-typed `!` bash and 1 = unread are desktop-only (not on the wire).
    static let priorityIdle = 0

    // ─── Palette ─────────────────────────────────────────────────────────────
    // Theme-independent tab-dot constants. Running and question mirror the
    // desktop Ion Dark intent — steel-teal running (statusRunning #5EA9C9) and
    // purple question (statusQuestion #A78BFA) — kept legibly distinct from each
    // other, from the accent blue, and from the orange permission dot.
    static let errorColor = Color(hex: 0xC47060)
    static let permissionOrange = Color(hex: 0xE8854A)
    static let childrenYellow = Color(hex: 0xF59E0B)
    static let runningTeal = Color(hex: 0x5EA9C9)
    static let questionPurple = Color(hex: 0xA78BFA)
    /// Blaze pink for the shell-activity dot. Mirrors the desktop Ion Dark
    /// `statusBash` (#ff2d95). Like every constant in this block the value is
    /// theme-independent by design (see the note above), and the Ion Dark
    /// source value it mirrors is pinned by assets/theme-parity.json —
    /// asserted from both sides by theme-parity.test.ts and ThemeParityTests.
    /// Deliberately far from errorColor so "a shell is running" never reads as
    /// an error.
    static let shellPink = Color(hex: 0xFF2D95)
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

        // 3. Running / connecting → teal pulse (foreground active). Wins over
        //    the passive plan/question waits below. Teal (not the orange
        //    permission color) so a pulsing running dot and a steady permission
        //    dot never read as the same signal.
        if tab.status == .running || tab.status == .connecting {
            return GroupTabStatus(
                priority: priorityRunning,
                color: runningTeal,
                shouldPulse: true,
                glow: true,
                glowColor: runningTeal
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

        // 5. Awaiting background shells → pink pulse (orchestrator idle,
        //    background bash commands still running). Ranked directly under
        //    children: both are active background work, and both outrank the
        //    passive plan/question waits, but the agent signal is the richer
        //    one when both are in flight.
        if (tab.backgroundShellCount ?? 0) > 0 {
            return GroupTabStatus(
                priority: priorityBashBackground,
                color: shellPink,
                shouldPulse: true,
                glow: true,
                glowColor: shellPink
            )
        }

        // 6. Plan ready → green glow (ExitPlanMode denial, run idle/completed).
        if hasPlanReady && (tab.status == .idle || tab.status == .completed) {
            return GroupTabStatus(
                priority: priorityPlanReady,
                color: .green,
                shouldPulse: false,
                glow: true,
                glowColor: .green
            )
        }

        // 7. Question pending → purple glow (AskUserQuestion denial).
        if hasQuestion && (tab.status == .idle || tab.status == .completed) {
            return GroupTabStatus(
                priority: priorityQuestion,
                color: questionPurple,
                shouldPulse: false,
                glow: true,
                glowColor: questionPurple
            )
        }

        // 8. Idle → dimmed gray (no pulse, no glow).
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

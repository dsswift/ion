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
// ─── Priority cascade ───────────────────────────────────────────────────────
//
// The cross-client order is pinned by
// `assets/design-system/status-cascade.json`. StatusCascadeParityTests asserts
// this local declaration against that fixture.
//
// `bash-background` is reachable: the desktop projects
// `backgroundShellCount` onto RemoteTabState, so a session holding for
// background bash commands renders the pink dot here exactly as it does on the
// desktop. `bash` (user-typed `!` bash) and `unread` remain unreachable on
// iOS: the wire carries neither `bashExecuting` nor `hasUnread`, which are
// desktop-renderer-only `TabState` fields.
//
// iOS wire nuance vs. desktop: on the desktop, ExitPlanMode / AskUserQuestion
// denials live on a separate `permissionDenied` field while `permissionQueue`
// holds only generic tool-permission requests. On iOS the snapshot merges all
// of them into `permissionQueue`, tagged by `toolName`. So the iOS classifier
// distinguishes them by tool name: `ExitPlanMode` → plan-ready, `AskUserQuestion`
// → question, anything else → generic permission.

/// Semantic state returned by shared cascade. Views own shape rendering;
/// classifier owns only priority and state.
enum TabStatusState: Equatable {
    case error, permission, running, children, bash, planReady, question, idle

    func color(_ theme: AppTheme) -> Color {
        switch self {
        case .error: theme.statusError
        case .permission: theme.statusWarning
        case .running: theme.statusRunning
        case .children: theme.statusWaitingChildren
        case .bash: theme.statusBash
        case .planReady: theme.statusDone
        case .question: theme.statusQuestion
        case .idle: theme.statusIdle
        }
    }

    var breathes: Bool {
        switch self {
        case .running, .children, .bash: true
        default: false
        }
    }
}

struct GroupTabStatus: Equatable {
    let priority: Int
    let state: TabStatusState
}

enum TabStatusRollup {
    static let statusCascade: [(name: String, iosReachable: Bool)] = [
        ("error", true), ("permission", true), ("running", true),
        ("children", true), ("bash-background", true), ("plan-ready", true),
        ("question", true), ("bash", false), ("unread", false), ("idle", true)
    ]

    private static func priority(for name: String) -> Int {
        guard let index = statusCascade.firstIndex(where: { $0.name == name }) else {
            preconditionFailure("unknown tab-status cascade entry: \(name)")
        }
        return statusCascade.count - index - 1
    }

    // Compatibility palette constants retained for existing parity tests. Rendering
    // resolves `TabStatusState` through active AppTheme, never these values.
    static let errorColor = IonDarkTheme().statusError
    static let permissionAmber = IonDarkTheme().statusWarning
    static let runningOrange = IonDarkTheme().statusRunning
    static let childrenYellow = IonDarkTheme().statusWaitingChildren
    static let shellPink = IonDarkTheme().statusBash
    static let questionPurple = IonDarkTheme().statusQuestion
    static let idleGray = IonDarkTheme().statusIdle

    static let priorityError = priority(for: "error")
    static let priorityPermission = priority(for: "permission")
    static let priorityRunning = priority(for: "running")
    static let priorityChildren = priority(for: "children")
    static let priorityBashBackground = priority(for: "bash-background")
    static let priorityPlanReady = priority(for: "plan-ready")
    static let priorityQuestion = priority(for: "question")
    static let priorityIdle = priority(for: "idle")

    static func classify(_ tab: RemoteTabState) -> GroupTabStatus {
        if tab.status == .dead || tab.status == .failed { return .init(priority: priorityError, state: .error) }
        let genericPermission = tab.permissionQueue.contains { $0.toolName != "ExitPlanMode" && $0.toolName != "AskUserQuestion" }
        let planReady = tab.permissionQueue.contains { $0.toolName == "ExitPlanMode" }
        let question = tab.permissionQueue.contains { $0.toolName == "AskUserQuestion" }
        if genericPermission { return .init(priority: priorityPermission, state: .permission) }
        if tab.status == .running || tab.status == .connecting { return .init(priority: priorityRunning, state: .running) }
        if tab.hasRunningChildren == true { return .init(priority: priorityChildren, state: .children) }
        if (tab.backgroundShellCount ?? 0) > 0 { return .init(priority: priorityBashBackground, state: .bash) }
        if planReady && (tab.status == .idle || tab.status == .completed) { return .init(priority: priorityPlanReady, state: .planReady) }
        if question && (tab.status == .idle || tab.status == .completed) { return .init(priority: priorityQuestion, state: .question) }
        return .init(priority: priorityIdle, state: .idle)
    }

    static func groupStatus(tabs: [RemoteTabState]) -> GroupTabStatus {
        var best = GroupTabStatus(priority: priorityIdle, state: .idle)
        for tab in tabs where tab.isTerminalOnly != true {
            let status = classify(tab)
            if status.priority > best.priority { best = status }
        }
        return best
    }
}

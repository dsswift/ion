import XCTest
import SwiftUI
@testable import IonRemote

/// Pins the group-header status rollup cascade (`TabStatusRollup`).
///
/// This is the iOS parity surface for the desktop group-pill GroupStatusDot
/// (`getGroupStatusColor` in TabStripGroupStatus.ts). The rollup folds the
/// per-tab classifier across a group's tabs and returns the highest-priority
/// status. Both the per-tab dot (`TabRowView.statusInfo`) and this rollup fold
/// the SAME classifier (`TabStatusRollup.classify`), so this suite also guards
/// the per-tab cascade against drift.
///
/// iOS wire note: the desktop→iOS wire does not project `bashExecuting`
/// (priority 2) or `hasUnread` (priority 1) — those `TabState` fields are
/// desktop-renderer-only. So the reachable iOS levels are error(8),
/// permission(7), running(6), running-children(5), plan-ready(4),
/// question(3), and idle(0). The numeric priorities still match desktop so a
/// future wire field slots into the gap without renumbering.
final class TabListGroupHeaderTests: XCTestCase {

    // MARK: - Helpers

    private func makeTab(
        id: String = "tab",
        status: TabStatus = .idle,
        hasRunningChildren: Bool? = nil,
        permissionQueue: [PermissionRequest] = [],
        isTerminalOnly: Bool? = nil,
        backgroundShellCount: Int? = nil
    ) -> RemoteTabState {
        var tab = RemoteTabState(
            id: id,
            title: "Tab",
            customTitle: nil,
            status: status,
            workingDirectory: "/tmp",
            permissionMode: .auto,
            thinkingEffort: nil,
            permissionQueue: permissionQueue,
            isTerminalOnly: isTerminalOnly,
            hasRunningChildren: hasRunningChildren
        )
        tab.backgroundShellCount = backgroundShellCount
        return tab
    }

    private func permission(_ toolName: String) -> PermissionRequest {
        PermissionRequest(
            questionId: "qid-\(toolName)",
            toolName: toolName,
            toolInput: nil,
            options: []
        )
    }

    private func planReadyEntry() -> PermissionRequest { permission("ExitPlanMode") }
    private func questionEntry() -> PermissionRequest { permission("AskUserQuestion") }
    private func genericPermissionEntry() -> PermissionRequest { permission("Bash") }

    // MARK: - Per-level classify coverage (reachable levels)

    func testClassifyError() {
        XCTAssertEqual(TabStatusRollup.classify(makeTab(status: .dead)).priority, TabStatusRollup.priorityError)
        XCTAssertEqual(TabStatusRollup.classify(makeTab(status: .failed)).priority, TabStatusRollup.priorityError)
    }

    func testClassifyPermission() {
        let s = TabStatusRollup.classify(makeTab(status: .idle, permissionQueue: [genericPermissionEntry()]))
        XCTAssertEqual(s.priority, TabStatusRollup.priorityPermission)
        XCTAssertTrue(s.glow)
        XCTAssertFalse(s.shouldPulse)
    }

    func testClassifyRunning() {
        let running = TabStatusRollup.classify(makeTab(status: .running))
        XCTAssertEqual(running.priority, TabStatusRollup.priorityRunning)
        XCTAssertTrue(running.shouldPulse)
        // Running is the steel-teal dot, NOT the orange permission color — a
        // pulsing running dot and a steady permission dot must never share a hue.
        XCTAssertEqual(running.color, TabStatusRollup.runningTeal)
        XCTAssertNotEqual(running.color, TabStatusRollup.permissionOrange)
        XCTAssertEqual(TabStatusRollup.classify(makeTab(status: .connecting)).priority, TabStatusRollup.priorityRunning)
    }

    func testClassifyRunningChildren() {
        let s = TabStatusRollup.classify(makeTab(status: .idle, hasRunningChildren: true))
        XCTAssertEqual(s.priority, TabStatusRollup.priorityChildren)
        XCTAssertTrue(s.shouldPulse)
        XCTAssertEqual(s.color, TabStatusRollup.childrenYellow)
    }

    // ─── Background shell commands ──────────────────────────────────────────
    //
    // Level 5 of the cascade. Reachable on iOS because the desktop snapshot
    // projects backgroundShellCount onto RemoteTabState — see the note in
    // TabStatusRollup.swift's header, which previously documented level 5's
    // neighborhood as desktop-only.

    func testClassifyBackgroundShells() {
        let s = TabStatusRollup.classify(makeTab(status: .idle, backgroundShellCount: 2))
        XCTAssertEqual(s.priority, TabStatusRollup.priorityBashBackground)
        XCTAssertTrue(s.shouldPulse)
        XCTAssertEqual(s.color, TabStatusRollup.shellPink)
        // Never confusable with the error dot: error is the top-priority state
        // and a "your build is running" pink that reads as red is misleading.
        XCTAssertNotEqual(s.color, TabStatusRollup.errorColor)
    }

    func testRunningChildrenOutrankBackgroundShells() {
        // Both kinds of background work in flight: the richer agent signal wins,
        // matching the desktop cascade.
        let s = TabStatusRollup.classify(
            makeTab(status: .idle, hasRunningChildren: true, backgroundShellCount: 3)
        )
        XCTAssertEqual(s.priority, TabStatusRollup.priorityChildren)
        XCTAssertEqual(s.color, TabStatusRollup.childrenYellow)
    }

    func testForegroundRunningOutranksBackgroundShells() {
        let s = TabStatusRollup.classify(makeTab(status: .running, backgroundShellCount: 3))
        XCTAssertEqual(s.priority, TabStatusRollup.priorityRunning)
    }

    func testBackgroundShellsOutrankPlanReady() {
        // Active background work beats a passive "waiting on you" state — the
        // same ranking argument the children branch makes.
        let s = TabStatusRollup.classify(
            makeTab(status: .idle, permissionQueue: [planReadyEntry()], backgroundShellCount: 1)
        )
        XCTAssertEqual(s.priority, TabStatusRollup.priorityBashBackground)
    }

    func testZeroBackgroundShellsFallsThroughToIdle() {
        let s = TabStatusRollup.classify(makeTab(status: .idle, backgroundShellCount: 0))
        XCTAssertEqual(s.priority, TabStatusRollup.priorityIdle)
    }

    /// The iOS priority numbers must match the desktop constants in
    /// TabStripGroupStatus.ts exactly — the two folds disagree otherwise on a
    /// tab that matches two states at once.
    func testPriorityConstantsMatchDesktop() {
        XCTAssertEqual(TabStatusRollup.priorityError, 9)
        XCTAssertEqual(TabStatusRollup.priorityPermission, 8)
        XCTAssertEqual(TabStatusRollup.priorityRunning, 7)
        XCTAssertEqual(TabStatusRollup.priorityChildren, 6)
        XCTAssertEqual(TabStatusRollup.priorityBashBackground, 5)
        XCTAssertEqual(TabStatusRollup.priorityPlanReady, 4)
        XCTAssertEqual(TabStatusRollup.priorityQuestion, 3)
        XCTAssertEqual(TabStatusRollup.priorityIdle, 0)
    }

    func testClassifyPlanReady() {
        let s = TabStatusRollup.classify(makeTab(status: .idle, permissionQueue: [planReadyEntry()]))
        XCTAssertEqual(s.priority, TabStatusRollup.priorityPlanReady)
        XCTAssertEqual(s.color, .green)
        XCTAssertTrue(s.glow)
        XCTAssertFalse(s.shouldPulse)
    }

    func testClassifyQuestion() {
        let s = TabStatusRollup.classify(makeTab(status: .idle, permissionQueue: [questionEntry()]))
        XCTAssertEqual(s.priority, TabStatusRollup.priorityQuestion)
        // Dedicated purple, distinct from the teal running dot — the two-blues
        // collision this replaced is guarded by the inequality below.
        XCTAssertEqual(s.color, TabStatusRollup.questionPurple)
        XCTAssertNotEqual(s.color, TabStatusRollup.runningTeal)
        XCTAssertTrue(s.glow)
    }

    func testClassifyIdle() {
        let s = TabStatusRollup.classify(makeTab(status: .idle))
        XCTAssertEqual(s.priority, TabStatusRollup.priorityIdle)
        XCTAssertEqual(s.color, TabStatusRollup.idleGray)
        XCTAssertFalse(s.glow)
        XCTAssertFalse(s.shouldPulse)
    }

    // MARK: - b8e21298 regression: running-children outranks plan-ready

    /// A tab with BOTH hasRunningChildren=true AND a plan-ready ExitPlanMode
    /// denial must classify as running-children (priority 5), not plan-ready
    /// (priority 4). This is the exact desktop fix b8e21298 ordering.
    func testRunningChildrenOutranksPlanReady() {
        let tab = makeTab(status: .idle, hasRunningChildren: true, permissionQueue: [planReadyEntry()])
        let s = TabStatusRollup.classify(tab)
        XCTAssertEqual(s.priority, TabStatusRollup.priorityChildren,
                       "hasRunningChildren must outrank plan-ready")
        XCTAssertEqual(s.color, TabStatusRollup.childrenYellow)
        XCTAssertTrue(s.shouldPulse)
    }

    // MARK: - Group fold

    /// An all-idle group returns idle.
    func testGroupAllIdleReturnsIdle() {
        let tabs = [
            makeTab(id: "a", status: .idle),
            makeTab(id: "b", status: .completed),
            makeTab(id: "c", status: .idle),
        ]
        let s = TabStatusRollup.groupStatus(tabs: tabs)
        XCTAssertEqual(s.priority, TabStatusRollup.priorityIdle)
        XCTAssertEqual(s.color, TabStatusRollup.idleGray)
    }

    /// An empty group returns idle.
    func testGroupEmptyReturnsIdle() {
        XCTAssertEqual(TabStatusRollup.groupStatus(tabs: []).priority, TabStatusRollup.priorityIdle)
    }

    /// A group with mixed statuses returns the highest-priority dot. Here a
    /// dead tab (error, 8) beats running (6), plan-ready (4), and idle (0).
    func testGroupMixedReturnsHighestPriority() {
        let tabs = [
            makeTab(id: "idle", status: .idle),
            makeTab(id: "planready", status: .idle, permissionQueue: [planReadyEntry()]),
            makeTab(id: "running", status: .running),
            makeTab(id: "dead", status: .dead),
        ]
        let s = TabStatusRollup.groupStatus(tabs: tabs)
        XCTAssertEqual(s.priority, TabStatusRollup.priorityError,
                       "error (dead) must win the group fold")
        XCTAssertEqual(s.color, TabStatusRollup.errorColor)
    }

    /// The group fold surfaces running-children when it is the top signal,
    /// even alongside a lower plan-ready tab — group-level b8e21298 parity.
    func testGroupRunningChildrenBeatsPlanReady() {
        let tabs = [
            makeTab(id: "planready", status: .idle, permissionQueue: [planReadyEntry()]),
            makeTab(id: "children", status: .idle, hasRunningChildren: true),
        ]
        let s = TabStatusRollup.groupStatus(tabs: tabs)
        XCTAssertEqual(s.priority, TabStatusRollup.priorityChildren)
        XCTAssertTrue(s.shouldPulse)
    }

    /// Terminal-only tabs are excluded from the fold (they carry no
    /// conversation status), matching the desktop getGroupStatusColor filter.
    /// A group of one running terminal-only tab folds to idle.
    func testGroupExcludesTerminalOnlyTabs() {
        let tabs = [
            makeTab(id: "term", status: .running, isTerminalOnly: true),
            makeTab(id: "idle", status: .idle),
        ]
        let s = TabStatusRollup.groupStatus(tabs: tabs)
        XCTAssertEqual(s.priority, TabStatusRollup.priorityIdle,
                       "terminal-only tabs must not contribute status to the group rollup")
    }
}

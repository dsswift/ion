import XCTest
@testable import IonRemote

/// Pins the run-activity indicator decision for `ConversationStatusBar`
/// (`resolveRunActivity`), the testable seam behind the status-bar dot + label.
///
/// Regression: the bar previously rendered the dot/label only inside
/// `if let state = statusState`, where `statusState` came from
/// `StatusFields.state` — a non-Codable, snapshot-excluded field on iOS. When
/// the orchestrator went idle with a dispatched agent still running,
/// `statusState` was nil and the yellow "waiting for N agent(s)"
/// label never appeared. The fix derives the dot/label from `isRunning`
/// (orchestrator run-state, from `tab.status`) and the live `runningAgentCount`.
///
/// The idle + running-agent case is the regression assertion: it is red if the
/// block stays gated on `statusState` (the label would never render) and green
/// once the decision is driven by `runningAgentCount`.
final class ConversationStatusBarWaitingTests: XCTestCase {

    func testRunningOrchestratorShowsRunningLabel() {
        let a = ConversationStatusBar.resolveRunActivity(isRunning: true, runningAgentCount: 0)
        XCTAssertTrue(a.show)
        XCTAssertTrue(a.isRunning)
        XCTAssertEqual(a.label, "running")
    }

    func testRunningOrchestratorWinsOverBackgroundAgents() {
        // Foreground orange beats child-waiting yellow — when the orchestrator
        // is running, the label is "running" regardless of running children.
        let a = ConversationStatusBar.resolveRunActivity(isRunning: true, runningAgentCount: 3)
        XCTAssertTrue(a.show)
        XCTAssertTrue(a.isRunning)
        XCTAssertEqual(a.label, "running")
    }

    func testIdleWithOneRunningAgentShowsSingularWaitingLabel() {
        // REGRESSION: orchestrator idle, one dispatched agent still running.
        let a = ConversationStatusBar.resolveRunActivity(isRunning: false, runningAgentCount: 1)
        XCTAssertTrue(a.show)
        XCTAssertFalse(a.isRunning)
        XCTAssertEqual(a.label, "waiting for 1 agent")
    }

    func testIdleWithMultipleRunningAgentsPluralizes() {
        let a = ConversationStatusBar.resolveRunActivity(isRunning: false, runningAgentCount: 2)
        XCTAssertTrue(a.show)
        XCTAssertFalse(a.isRunning)
        XCTAssertEqual(a.label, "waiting for 2 agents")
    }

    func testIdleWithNoRunningAgentsShowsNothing() {
        let a = ConversationStatusBar.resolveRunActivity(isRunning: false, runningAgentCount: 0)
        XCTAssertFalse(a.show)
    }

    // MARK: - Background-shell branch
    //
    // The iOS counterpart of the desktop regression fixed alongside this: a
    // live background Bash task (Bash run_in_background + notify_on_complete)
    // sets `backgroundShellCount > 0` with zero running agents. Before this
    // fix, ConversationStatusBar had no shell branch at all — `resolveRunActivity`
    // took only `isRunning`/`runningAgentCount`, so a plain conversation waiting
    // on an outstanding shell rendered NOTHING (the same silent-indicator gap
    // EngineInstanceBar's `statusIndicator` had already closed for the
    // multi-instance bar). These tests pin the newly-added shell branch and its
    // priority under agents, matching EngineInstanceBar.statusIndicator.

    func testIdleWithOneBackgroundShellShowsSingularShellLabel() {
        let a = ConversationStatusBar.resolveRunActivity(isRunning: false, runningAgentCount: 0, runningShellCount: 1)
        XCTAssertTrue(a.show)
        XCTAssertFalse(a.isRunning)
        XCTAssertTrue(a.isWaitingShells)
        XCTAssertEqual(a.label, "waiting for 1 background shell")
    }

    func testIdleWithMultipleBackgroundShellsPluralizes() {
        let a = ConversationStatusBar.resolveRunActivity(isRunning: false, runningAgentCount: 0, runningShellCount: 3)
        XCTAssertTrue(a.show)
        XCTAssertTrue(a.isWaitingShells)
        XCTAssertEqual(a.label, "waiting for 3 background shells")
    }

    func testRunningAgentsOutrankBackgroundShells() {
        // REGRESSION-shaped case: both an agent and a shell are outstanding.
        // The richer agent signal must win, exactly like EngineInstanceBar's
        // cascade (runningAgentCount checked before backgroundShellCount).
        let a = ConversationStatusBar.resolveRunActivity(isRunning: false, runningAgentCount: 1, runningShellCount: 5)
        XCTAssertTrue(a.show)
        XCTAssertFalse(a.isWaitingShells)
        XCTAssertEqual(a.label, "waiting for 1 agent")
    }

    func testRunningOrchestratorWinsOverBackgroundShells() {
        let a = ConversationStatusBar.resolveRunActivity(isRunning: true, runningAgentCount: 0, runningShellCount: 2)
        XCTAssertTrue(a.show)
        XCTAssertTrue(a.isRunning)
        XCTAssertFalse(a.isWaitingShells)
        XCTAssertEqual(a.label, "running")
    }

    func testIdleWithNoAgentsOrShellsShowsNothing() {
        let a = ConversationStatusBar.resolveRunActivity(isRunning: false, runningAgentCount: 0, runningShellCount: 0)
        XCTAssertFalse(a.show)
    }
}

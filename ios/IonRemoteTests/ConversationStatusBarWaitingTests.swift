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
}

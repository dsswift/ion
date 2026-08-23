import XCTest
@testable import IonRemote

/// Pins the abort-affordance visibility gate (iOS interrupt parity).
///
/// The stop button must appear whenever the conversation is running OR while
/// dispatched background agents are still alive — mirroring the desktop's
/// `(isRunning || hasRunningChildren)` interrupt-button gate. The pure
/// `ConversationView.computeCanAbort(status:hasRunningChildren:)` helper makes
/// that logic testable without instantiating the SwiftUI view.
///
/// `computeCanAbort` was migrated from the now-deleted dead `InputBar.swift`
/// to `ConversationView+InputBar.swift` as part of the Fix 3 retirement.
final class InputBarAbortGateTests: XCTestCase {

    func testRunningStatusCanAbort() {
        XCTAssertTrue(ConversationView.computeCanAbort(status: .running, hasRunningChildren: nil))
        XCTAssertTrue(ConversationView.computeCanAbort(status: .running, hasRunningChildren: false))
    }

    func testConnectingStatusCanAbort() {
        XCTAssertTrue(ConversationView.computeCanAbort(status: .connecting, hasRunningChildren: nil))
    }

    func testIdleWithRunningChildrenCanAbort() {
        // The previously-missing case from the bug report: orchestrator idle but
        // dispatched agents still running — the user must still be able to abort.
        XCTAssertTrue(ConversationView.computeCanAbort(status: .idle, hasRunningChildren: true))
    }

    func testIdleWithoutRunningChildrenCannotAbort() {
        XCTAssertFalse(ConversationView.computeCanAbort(status: .idle, hasRunningChildren: nil))
        XCTAssertFalse(ConversationView.computeCanAbort(status: .idle, hasRunningChildren: false))
    }

    func testCompletedWithRunningChildrenCanAbort() {
        // A completed/failed parent run can still have a runaway dispatched agent;
        // the affordance must stay available to reap it.
        XCTAssertTrue(ConversationView.computeCanAbort(status: .completed, hasRunningChildren: true))
        XCTAssertTrue(ConversationView.computeCanAbort(status: .failed, hasRunningChildren: true))
    }

    func testTerminalStatusWithoutChildrenCannotAbort() {
        XCTAssertFalse(ConversationView.computeCanAbort(status: .completed, hasRunningChildren: false))
        XCTAssertFalse(ConversationView.computeCanAbort(status: .dead, hasRunningChildren: nil))
    }

    func testIdleWithActiveBackgroundTaskCanAbort() {
        XCTAssertTrue(ConversationView.computeCanAbort(
            status: .idle,
            hasRunningChildren: false,
            hasActiveBackgroundTasks: true
        ))
    }

    func testNilStatusWithoutChildrenCannotAbort() {
        XCTAssertFalse(ConversationView.computeCanAbort(status: nil, hasRunningChildren: nil))
    }

    func testNilStatusWithRunningChildrenCanAbort() {
        XCTAssertTrue(ConversationView.computeCanAbort(status: nil, hasRunningChildren: true))
    }
}

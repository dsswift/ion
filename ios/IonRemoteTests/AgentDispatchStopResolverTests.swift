import XCTest
@testable import IonRemote

final class AgentDispatchStopResolverTests: XCTestCase {
    private func dispatch(_ id: String, status: String) -> DispatchInfo {
        DispatchInfo(
            id: id,
            task: "task",
            model: "model",
            conversationId: "conversation-\(id)",
            elapsed: nil,
            status: status,
            startTime: nil
        )
    }

    func testRunningIdsExcludeDoneAndEmpty() {
        let result = AgentDispatchStopResolver.runningDispatchIds(
            dispatches: [
                dispatch("running-a", status: "running"),
                dispatch("done-a", status: "done"),
                dispatch("", status: "running"),
                dispatch("running-b", status: "running"),
            ],
            agentStatus: "running"
        )
        XCTAssertEqual(result, ["running-a", "running-b"])
    }

    func testRunningIdsDeduplicateSameInstance() {
        let result = AgentDispatchStopResolver.runningDispatchIds(
            dispatches: [
                dispatch("same", status: "running"),
                dispatch("same", status: "running"),
            ],
            agentStatus: "running"
        )
        XCTAssertEqual(result, ["same"])
    }

    func testEmptyMemberStatusFallsBackToAgentStatus() {
        let result = AgentDispatchStopResolver.runningDispatchIds(
            dispatches: [dispatch("legacy", status: "")],
            agentStatus: "running"
        )
        XCTAssertEqual(result, ["legacy"])
    }

    func testExplicitDoneStatusDoesNotBorrowRunningAgentStatus() {
        let result = AgentDispatchStopResolver.runningDispatchIds(
            dispatches: [dispatch("done", status: "done")],
            agentStatus: "running"
        )
        XCTAssertTrue(result.isEmpty)
    }

    func testPrimaryTargetsLatestRunningInstance() {
        let result = AgentDispatchStopResolver.primaryDispatchId(
            dispatches: [
                dispatch("running-a", status: "running"),
                dispatch("done-a", status: "done"),
                dispatch("running-b", status: "running"),
            ],
            agentStatus: "running"
        )
        XCTAssertEqual(result, "running-b")
    }
}

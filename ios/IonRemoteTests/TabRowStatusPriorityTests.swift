import XCTest
@testable import IonRemote

final class TabRowStatusPriorityTests: XCTestCase {
    private func tab(status: TabStatus = .idle, children: Bool? = nil, permissions: [PermissionRequest] = []) -> RemoteTabState {
        RemoteTabState(id: "test", title: "Test", customTitle: nil, status: status, workingDirectory: "/tmp", permissionMode: .auto, thinkingEffort: nil, permissionQueue: permissions, hasRunningChildren: children)
    }

    private func permission(_ toolName: String) -> PermissionRequest {
        PermissionRequest(questionId: "test", toolName: toolName, toolInput: nil, options: [])
    }

    func testChildrenOutrankPlanReadyWithSemanticState() {
        let result = TabStatusRollup.classify(tab(children: true, permissions: [permission("ExitPlanMode")]))
        XCTAssertEqual(result.state, .children)
        XCTAssertTrue(result.state.breathes)
    }

    func testPlanReadyAndQuestionHaveStillSemanticStates() {
        XCTAssertEqual(TabStatusRollup.classify(tab(permissions: [permission("ExitPlanMode")])).state, .planReady)
        XCTAssertEqual(TabStatusRollup.classify(tab(permissions: [permission("AskUserQuestion")])).state, .question)
        XCTAssertFalse(TabStatusRollup.classify(tab(permissions: [permission("AskUserQuestion")])).state.breathes)
    }
}

import XCTest
@testable import IonRemote

final class TabListGroupHeaderTests: XCTestCase {
    private func tab(id: String, status: TabStatus = .idle, backgroundShellCount: Int? = nil) -> RemoteTabState {
        var value = RemoteTabState(id: id, title: "Test", customTitle: nil, status: status, workingDirectory: "/tmp", permissionMode: .auto, thinkingEffort: nil, permissionQueue: [])
        value.backgroundShellCount = backgroundShellCount
        return value
    }

    func testGroupUsesHighestSemanticState() {
        let result = TabStatusRollup.groupStatus(tabs: [tab(id: "idle"), tab(id: "running", status: .running), tab(id: "error", status: .failed)])
        XCTAssertEqual(result.state, .error)
    }

    func testBackgroundShellIsExecutingState() {
        let result = TabStatusRollup.classify(tab(id: "shell", backgroundShellCount: 1))
        XCTAssertEqual(result.state, .bash)
        XCTAssertTrue(result.state.breathes)
    }
}

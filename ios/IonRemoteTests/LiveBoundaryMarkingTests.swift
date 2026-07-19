import XCTest
@testable import IonRemote

/// RC-11: every live-event handler that appends a row to the conversation must
/// stamp `isLive = true` on that row so a first-page history replace can
/// preserve the live tail precisely instead of guessing from timestamps.
///
/// Each test here calls one handler, then checks that `messages.last?.isLive`
/// is true. The tests go RED on unfixed code (the handlers appended without
/// the `isLive` stamp) and GREEN after the fix.
@MainActor
final class LiveBoundaryMarkingTests: XCTestCase {

    private func seedTab(_ vm: SessionViewModel, id: String) {
        vm.tabs = [RemoteTabState(
            id: id, title: id, customTitle: nil, status: .running,
            workingDirectory: "/tmp", permissionMode: .auto, thinkingEffort: nil,
            permissionQueue: [], hasEngineExtension: false
        )]
    }

    func testInterceptRowIsLive() {
        let vm = SessionViewModel()
        seedTab(vm, id: "t")
        vm.handleEngineIntercept(tabId: "t", instanceId: nil,
            level: "banner", title: "Test", message: "body")
        let last = vm.conversationMessages("t").last
        XCTAssertEqual(last?.role, .harness)
        XCTAssertTrue(last?.isLive == true,
            "intercept row must be stamped isLive so it survives a first-page history replace")
    }

    func testHarnessMessageRowIsLive() {
        let vm = SessionViewModel()
        seedTab(vm, id: "t")
        vm.handleEngineHarnessMessage(tabId: "t", instanceId: nil,
            message: "plain harness message", dedupKey: nil, dedupMode: nil)
        let last = vm.conversationMessages("t").last
        XCTAssertEqual(last?.role, .harness)
        XCTAssertTrue(last?.isLive == true,
            "harness message row must be stamped isLive")
    }

    func testHarnessMessageDividerRowIsLive() {
        let vm = SessionViewModel()
        seedTab(vm, id: "t")
        vm.handleEngineHarnessMessage(tabId: "t", instanceId: nil,
            message: "── Session started ──", dedupKey: nil, dedupMode: nil)
        let last = vm.conversationMessages("t").last
        XCTAssertEqual(last?.role, .system)
        XCTAssertTrue(last?.isLive == true,
            "harness divider (system role) row must be stamped isLive")
    }

    func testHarnessMessageWithDedupKeyIsLive() {
        let vm = SessionViewModel()
        seedTab(vm, id: "t")
        vm.handleEngineHarnessMessage(tabId: "t", instanceId: nil,
            message: "status", dedupKey: "my-key", dedupMode: nil)
        let last = vm.conversationMessages("t").last
        XCTAssertTrue(last?.isLive == true,
            "harness message with dedup key must be stamped isLive")
    }

    func testPlanFileWrittenRowIsLive() {
        let vm = SessionViewModel()
        seedTab(vm, id: "t")
        vm.handleEnginePlanFileWritten(tabId: "t", instanceId: nil,
            operation: "created", planFilePath: "/tmp/plan.md", planSlug: "my-plan")
        let last = vm.conversationMessages("t").last
        XCTAssertEqual(last?.role, .system)
        XCTAssertTrue(last?.isLive == true,
            "plan-file-written divider must be stamped isLive")
    }

    func testSteerInjectedRowIsLive() {
        let vm = SessionViewModel()
        seedTab(vm, id: "t")
        vm.handleEngineSteerInjected(tabId: "t", instanceId: nil, messageLength: 42)
        let last = vm.conversationMessages("t").last
        XCTAssertEqual(last?.role, .system)
        XCTAssertTrue(last?.isLive == true,
            "steer-injected divider must be stamped isLive")
    }

    func testPromptInjectedRowIsLive() {
        let vm = SessionViewModel()
        seedTab(vm, id: "t")
        vm.handleEnginePromptInjected(tabId: "t", instanceId: nil,
            prompt: "extension-injected prompt")
        let last = vm.conversationMessages("t").last
        XCTAssertEqual(last?.role, .user)
        XCTAssertTrue(last?.isLive == true,
            "prompt-injected user row must be stamped isLive")
    }

    func testEngineErrorRowIsLive() {
        let vm = SessionViewModel()
        seedTab(vm, id: "t")
        vm.handleEngineError(tabId: "t", instanceId: nil, message: "provider timeout")
        let msgs = vm.conversationMessages("t")
        // handleEngineError also sets tab idle — find the system message
        let errRow = msgs.first(where: { $0.role == .system })
        XCTAssertNotNil(errRow)
        XCTAssertTrue(errRow?.isLive == true,
            "engine-error system row must be stamped isLive")
    }

    func testEngineNotifyRowIsLive() {
        let vm = SessionViewModel()
        seedTab(vm, id: "t")
        vm.handleEngineNotify(tabId: "t", instanceId: nil,
            message: "rate limit hit", level: "warning")
        let last = vm.conversationMessages("t").last
        XCTAssertEqual(last?.role, .system)
        XCTAssertTrue(last?.isLive == true,
            "engine-notify system row must be stamped isLive")
    }
}

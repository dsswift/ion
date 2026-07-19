import XCTest
@testable import IonRemote

/// RC-18: conversationLoadFailed / loadingConversation must be observable state
/// the view can render (a reload affordance / spinner), not silently-blank
/// dead state. These pin the VM-side contract the ConversationView banner reads.
@MainActor
final class ConversationLoadFailedStateTests: XCTestCase {

    private func seedTab(_ vm: SessionViewModel, id: String) {
        vm.tabs = [RemoteTabState(
            id: id, title: id, customTitle: nil, status: .idle,
            workingDirectory: "/tmp", permissionMode: .auto, thinkingEffort: nil,
            permissionQueue: [], hasEngineExtension: false
        )]
    }

    /// A successful history load clears a prior failed flag so the banner goes
    /// away on reload success.
    func testSuccessfulLoadClearsFailedFlag() {
        let vm = SessionViewModel()
        seedTab(vm, id: "t")
        vm.conversationLoadFailed.insert("t")

        vm.handleConversationHistory(tabId: "t", newMessages: [], hasMore: false, cursor: nil)

        XCTAssertFalse(vm.conversationLoadFailed.contains("t"),
            "a successful history load must clear conversationLoadFailed so the retry banner dismisses")
    }

    /// loadConversation (the banner's Reload action) clears the failed flag and
    /// marks the load in flight, so the banner swaps to the loading state.
    func testReloadClearsFailedAndMarksLoading() {
        let vm = SessionViewModel()
        seedTab(vm, id: "t")
        vm.conversationLoadFailed.insert("t")

        vm.loadConversation(tabId: "t")

        XCTAssertFalse(vm.conversationLoadFailed.contains("t"),
            "Reload must clear the failed flag")
        XCTAssertTrue(vm.loadingConversation.contains("t"),
            "Reload must mark the load in flight so the view shows a spinner, not the failed banner")
    }
}

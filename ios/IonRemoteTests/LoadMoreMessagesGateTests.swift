import XCTest
@testable import IonRemote

/// RC-15 / RC-16: scroll-up pagination gating in loadMoreMessages.
///
/// `loadMoreMessages` is the method the ChatCollectionView reached-top hook now
/// calls. It must only issue a `desktop_load_conversation` with the stored
/// cursor when there IS older history (hasMore == true, cursor present) and no
/// load is already in flight. These tests pin that gate via the essential send
/// queue (loadMoreMessages sends with intent .automaticEssential while
/// disconnected, so the command lands in pendingEssentialQueue).
@MainActor
final class LoadMoreMessagesGateTests: XCTestCase {

    private func seedTab(_ vm: SessionViewModel, id: String) {
        vm.tabs = [RemoteTabState(
            id: id, title: id, customTitle: nil, status: .idle,
            workingDirectory: "/tmp", permissionMode: .auto, thinkingEffort: nil,
            permissionQueue: [], hasEngineExtension: false
        )]
    }

    func testLoadMoreFiresWithCursorWhenMoreHistoryExists() {
        let vm = SessionViewModel()
        seedTab(vm, id: "t")
        vm.conversationHasMore["t"] = true
        vm.conversationCursor["t"] = "cursor-older"

        vm.loadMoreMessages(tabId: "t")

        let entry = vm.pendingEssentialQueue.first { $0.key == "loadConversation:t" }
        XCTAssertNotNil(entry, "loadMoreMessages must issue a load when hasMore + cursor are set")
        // The command must carry the stored cursor (before:), not nil.
        if case .loadConversation(_, let before)? = entry?.command {
            XCTAssertEqual(before, "cursor-older", "the older-page load must carry the stored cursor")
        } else {
            XCTFail("queued command must be a loadConversation")
        }
    }

    func testLoadMoreNoOpsWhenNoMoreHistory() {
        let vm = SessionViewModel()
        seedTab(vm, id: "t")
        vm.conversationHasMore["t"] = false
        vm.conversationCursor["t"] = "cursor-older"

        vm.loadMoreMessages(tabId: "t")

        XCTAssertNil(vm.pendingEssentialQueue.first { $0.key == "loadConversation:t" },
            "loadMoreMessages must not fire when hasMore is false")
    }

    func testLoadMoreNoOpsWithoutCursor() {
        let vm = SessionViewModel()
        seedTab(vm, id: "t")
        vm.conversationHasMore["t"] = true
        // No cursor stored.

        vm.loadMoreMessages(tabId: "t")

        XCTAssertNil(vm.pendingEssentialQueue.first { $0.key == "loadConversation:t" },
            "loadMoreMessages must not fire without a stored cursor")
    }

    func testLoadMoreNoOpsWhileLoadInFlight() {
        let vm = SessionViewModel()
        seedTab(vm, id: "t")
        vm.conversationHasMore["t"] = true
        vm.conversationCursor["t"] = "cursor-older"
        vm.loadingConversation.insert("t") // a load is already running

        vm.loadMoreMessages(tabId: "t")

        XCTAssertNil(vm.pendingEssentialQueue.first { $0.key == "loadConversation:t" },
            "loadMoreMessages must coalesce: no second fire while a load is in flight")
    }
}

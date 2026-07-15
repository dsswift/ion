import XCTest
@testable import IonRemote

/// Regression test for the blank-transcript-on-load bug.
///
/// Before the fix, `loadConversation` called `setConversationMessages(tabId, [])`
/// at the very start — clearing the transcript BEFORE the fetch went out. The
/// conversation then rendered empty for the entire request round-trip, and
/// stayed empty indefinitely if the response was dropped.
///
/// The fix removes the pre-clear. Existing messages remain visible until the
/// replacement page arrives; `handleConversationHistory` replaces them wholesale
/// on the first page (cursor == nil).
///
/// This test seeds messages, calls `loadConversation`, and asserts the messages
/// survive the call. On the unfixed code the pre-clear empties the list and the
/// assertion fails.
@MainActor
final class SessionViewModelLoadConversationTests: XCTestCase {

    private func makeMessage(id: String) -> Message {
        Message(id: id, role: .assistant, content: "c", timestamp: 1)
    }

    func testLoadConversationKeepsExistingMessagesVisible() {
        let vm = SessionViewModel()
        let tabId = "tab-keep"

        // Seed an existing transcript (as if a prior load had populated it).
        vm.setConversationMessages(tabId: tabId, [makeMessage(id: "m1"), makeMessage(id: "m2")])
        XCTAssertEqual(vm.conversationMessages(tabId).count, 2, "precondition: transcript seeded")

        vm.loadConversation(tabId: tabId)

        // The transcript must NOT be cleared by loadConversation — the old
        // messages stay on screen until the replacement page arrives.
        XCTAssertEqual(vm.conversationMessages(tabId).count, 2,
            "loadConversation must keep existing messages visible; the pre-clear left the view blank for the whole round-trip")

        // The load is now in flight (marks the tab loading, clears loaded flag).
        XCTAssertTrue(vm.loadingConversation.contains(tabId), "load should be marked in flight")
        XCTAssertFalse(vm.conversationLoaded.contains(tabId), "loaded flag reset while a fresh load is in flight")

        // Stop the pending retry timer so it doesn't outlive the test.
        vm.cancelLoadTimer(tabId: tabId)
    }

    func testConversationHistoryReplacesTranscriptOnFirstPage() {
        let vm = SessionViewModel()
        let tabId = "tab-replace"

        // Seed stale messages, then deliver a fresh first page (cursor == nil).
        vm.setConversationMessages(tabId: tabId, [makeMessage(id: "old1"), makeMessage(id: "old2")])
        vm.handleConversationHistory(
            tabId: tabId,
            newMessages: [makeMessage(id: "new1")],
            hasMore: false,
            cursor: nil
        )

        // First page is a wholesale replace — stale messages are gone, only the
        // new page remains. This is what makes "keep old transcript visible until
        // replacement arrives" safe: the replacement fully supersedes it.
        let ids = vm.conversationMessages(tabId).map { $0.id }
        XCTAssertEqual(ids, ["new1"],
            "first-page history must replace the transcript, not append to the stale one")
    }
}

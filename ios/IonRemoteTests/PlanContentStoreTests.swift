import XCTest
@testable import IonRemote

/// Tests for `PlanContentStore.currentContent(for:)` — the partial-content
/// accessor that allows `PlanApprovalCardView` to render plan text as pages
/// arrive, rather than waiting for the final page (hasMore=false).
///
/// Regression guard: `currentContent` must return non-nil for any questionId
/// that has received at least one page, even when `complete == false`. Without
/// this, a normal snapshot-entry plan card (no inline preview) would stay blank
/// until the very last page of a multi-page plan arrived.
final class PlanContentStoreTests: XCTestCase {

    // MARK: - Helpers

    private func makeStore() -> PlanContentStore { PlanContentStore() }

    // MARK: - currentContent: no content yet → nil

    func testCurrentContent_noEntry_returnsNil() {
        let store = makeStore()
        XCTAssertNil(store.currentContent(for: "q-unknown"))
    }

    func testCurrentContent_markFetchingOnly_returnsNil() {
        // markFetching creates the FetchState but content is still "".
        let store = makeStore()
        store.markFetching(questionId: "q1", tabId: "t1")
        XCTAssertNil(store.currentContent(for: "q1"))
    }

    // MARK: - currentContent: partial content (first page, hasMore=true)

    func testCurrentContent_firstPageArrived_returnsPartial() {
        let store = makeStore()
        store.applyPage(questionId: "q1", content: "## Plan\nStep 1", totalBytes: 2000, hasMore: true)
        XCTAssertEqual(store.currentContent(for: "q1"), "## Plan\nStep 1")
        // Not complete yet — fullContent must still be nil.
        XCTAssertNil(store.fullContent(for: "q1"))
    }

    func testCurrentContent_multiplePartialPages_returnsAccumulated() {
        let store = makeStore()
        store.applyPage(questionId: "q1", content: "Page1 ", totalBytes: 3000, hasMore: true)
        store.applyPage(questionId: "q1", content: "Page2 ", totalBytes: 3000, hasMore: true)
        XCTAssertEqual(store.currentContent(for: "q1"), "Page1 Page2 ")
        XCTAssertNil(store.fullContent(for: "q1"))
    }

    // MARK: - currentContent after completion

    func testCurrentContent_afterComplete_returnsFull() {
        let store = makeStore()
        store.applyPage(questionId: "q1", content: "Complete body", totalBytes: 500, hasMore: false)
        // Both accessors must agree once complete.
        XCTAssertEqual(store.currentContent(for: "q1"), "Complete body")
        XCTAssertEqual(store.fullContent(for: "q1"), "Complete body")
    }

    func testCurrentContent_multiPageThenComplete_returnsFullAccumulated() {
        let store = makeStore()
        store.applyPage(questionId: "q1", content: "A", totalBytes: 2, hasMore: true)
        store.applyPage(questionId: "q1", content: "B", totalBytes: 2, hasMore: false)
        XCTAssertEqual(store.currentContent(for: "q1"), "AB")
        XCTAssertEqual(store.fullContent(for: "q1"), "AB")
    }

    // MARK: - Isolation between questionIds

    func testCurrentContent_isolatedPerQuestionId() {
        let store = makeStore()
        store.applyPage(questionId: "q1", content: "Q1 content", totalBytes: 10, hasMore: false)
        XCTAssertEqual(store.currentContent(for: "q1"), "Q1 content")
        XCTAssertNil(store.currentContent(for: "q2"))
    }

    // MARK: - clear resets currentContent

    func testCurrentContent_afterClear_returnsNil() {
        let store = makeStore()
        store.applyPage(questionId: "q1", content: "Some plan", totalBytes: 9, hasMore: false)
        store.clear(questionId: "q1")
        XCTAssertNil(store.currentContent(for: "q1"))
    }

    // MARK: - wipe resets all

    func testCurrentContent_afterWipe_returnsNil() {
        let store = makeStore()
        store.applyPage(questionId: "q1", content: "Body", totalBytes: 4, hasMore: false)
        store.applyPage(questionId: "q2", content: "Other", totalBytes: 5, hasMore: true)
        store.wipe()
        XCTAssertNil(store.currentContent(for: "q1"))
        XCTAssertNil(store.currentContent(for: "q2"))
    }
}

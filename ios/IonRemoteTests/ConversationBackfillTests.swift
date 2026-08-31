import XCTest
@testable import IonRemote

/// Background history backfill.
///
/// THE GAP THIS EXISTS FOR: a conversation opened with only its newest page and
/// fetched older pages when the user scrolled into them. That made scrolling
/// back through a long conversation a sequence of hitches, and it made an
/// attachment jump to an older row impossible — the page holding that row had
/// never been fetched, so there was no local row to scroll to and the tap was a
/// no-op no matter how correct the jump logic was.
///
/// The first fix walked the chain one default page at a time. That page is 10
/// rows, so a 1993-row conversation took ~200 round trips and rebuilt the
/// transcript on every one — seconds of visible flicker. A measured transcript
/// is ~1.3 KB per row and the relay allows a 12 MB frame, so the remainder
/// fits in ONE bulk request. These tests pin that: the newest page paints, then
/// a bulk request completes the conversation.
@MainActor
final class ConversationBackfillTests: XCTestCase {

    func testRequestsTheNextPageWhenMoreExist() {
        let backfill = ConversationBackfill()
        var requested: [String] = []

        backfill.advance(tabId: "t1", hasMore: true, cursor: "cur-1", isLoading: false) { cursor, _ in
            requested.append(cursor)
        }

        XCTAssertEqual(requested, ["cur-1"])
        XCTAssertTrue(backfill.isBackfilling("t1"))
    }

    func testRequestsABulkPageNotTheDefaultPage() {
        // The whole point: asking at the default size is what caused ~200
        // round trips and the flicker they produced.
        let backfill = ConversationBackfill()
        var sizes: [Int] = []

        backfill.advance(tabId: "t1", hasMore: true, cursor: "cur-1", isLoading: false) { _, size in
            sizes.append(size)
        }

        XCTAssertEqual(sizes, [ConversationBackfill.bulkPageSize])
        XCTAssertGreaterThanOrEqual(ConversationBackfill.bulkPageSize, 2000)
    }

    func testCompletesATypicalConversationInOneBulkRequest() {
        // ~2000 rows is one bulk page, so a real conversation is: first page
        // (already painted) + one request. Two renders, not two hundred.
        let backfill = ConversationBackfill()
        var requested: [String] = []

        backfill.advance(tabId: "t1", hasMore: true, cursor: "cur-1", isLoading: false) { cursor, _ in
            requested.append(cursor)
        }
        // The bulk page returned the rest of the conversation.
        backfill.advance(tabId: "t1", hasMore: false, cursor: nil, isLoading: false) { cursor, _ in
            requested.append(cursor)
        }

        XCTAssertEqual(requested.count, 1)
        XCTAssertTrue(backfill.isComplete("t1"))
    }

    func testDoesNotReRequestAConversationAlreadyComplete() {
        // Re-entering a fully loaded conversation must issue nothing.
        let backfill = ConversationBackfill()
        var requested: [String] = []

        backfill.advance(tabId: "t1", hasMore: false, cursor: nil, isLoading: false) { cursor, _ in
            requested.append(cursor)
        }
        XCTAssertTrue(backfill.isComplete("t1"))

        backfill.advance(tabId: "t1", hasMore: true, cursor: "cur-9", isLoading: false) { cursor, _ in
            requested.append(cursor)
        }
        XCTAssertTrue(requested.isEmpty)
    }

    func testWalksSeveralBulkPagesForAnUnusuallyLongConversation() {
        // A conversation larger than one bulk page still loops — but in
        // single-digit iterations, not hundreds.
        let backfill = ConversationBackfill()
        var requested: [String] = []
        let cursors = ["cur-1", "cur-2", "cur-3"]

        for (index, cursor) in cursors.enumerated() {
            backfill.advance(tabId: "t1", hasMore: true, cursor: cursor, isLoading: false) { c, _ in
                requested.append(c)
            }
            XCTAssertEqual(backfill.requestsIssued("t1"), index + 1)
        }
        backfill.advance(tabId: "t1", hasMore: false, cursor: nil, isLoading: false) { c, _ in
            requested.append(c)
        }

        XCTAssertEqual(requested, cursors)
        XCTAssertTrue(backfill.isComplete("t1"))
    }

    func testDoesNotRequestWhileAPageIsAlreadyInFlight() {
        // The first page load is itself an in-flight request; issuing another
        // would put two history requests on the transport for one tab.
        let backfill = ConversationBackfill()
        var requested: [String] = []

        backfill.advance(tabId: "t1", hasMore: true, cursor: "cur-1", isLoading: true) { cursor, _ in
            requested.append(cursor)
        }

        XCTAssertTrue(requested.isEmpty)
    }

    func testStopsWhenThereIsNoMoreHistory() {
        let backfill = ConversationBackfill()
        var requested: [String] = []

        backfill.advance(tabId: "t1", hasMore: false, cursor: "cur-1", isLoading: false) { cursor, _ in
            requested.append(cursor)
        }

        XCTAssertTrue(requested.isEmpty)
        XCTAssertFalse(backfill.isBackfilling("t1"))
    }

    func testStopsWhenTheCursorIsMissingOrEmpty() {
        // Without a cursor there is nothing to page from; requesting anyway
        // would re-fetch the newest page forever.
        let backfill = ConversationBackfill()
        var requested: [String] = []

        backfill.advance(tabId: "t1", hasMore: true, cursor: nil, isLoading: false) { c, _ in requested.append(c) }
        backfill.advance(tabId: "t2", hasMore: true, cursor: "", isLoading: false) { c, _ in requested.append(c) }

        XCTAssertTrue(requested.isEmpty)
    }

    func testTabsBackfillIndependently() {
        let backfill = ConversationBackfill()
        var requested: [String] = []

        backfill.advance(tabId: "t1", hasMore: true, cursor: "a-1", isLoading: false) { c, _ in requested.append(c) }
        backfill.advance(tabId: "t2", hasMore: true, cursor: "b-1", isLoading: false) { c, _ in requested.append(c) }

        XCTAssertEqual(requested, ["a-1", "b-1"])
        XCTAssertEqual(backfill.requestsIssued("t1"), 1)
        XCTAssertEqual(backfill.requestsIssued("t2"), 1)
    }

    func testResetForgetsATabSoReEntryBackfillsAgain() {
        // A wholesale transcript replace (fingerprint heal, reconnect reload)
        // invalidates the chain in flight: it was walking a transcript that no
        // longer exists.
        let backfill = ConversationBackfill()
        var requested: [String] = []

        backfill.advance(tabId: "t1", hasMore: true, cursor: "cur-1", isLoading: false) { c, _ in requested.append(c) }
        XCTAssertEqual(backfill.requestsIssued("t1"), 1)

        backfill.reset(tabId: "t1")
        XCTAssertEqual(backfill.requestsIssued("t1"), 0)
        XCTAssertFalse(backfill.isBackfilling("t1"))

        backfill.advance(tabId: "t1", hasMore: true, cursor: "cur-1", isLoading: false) { c, _ in requested.append(c) }
        XCTAssertEqual(requested, ["cur-1", "cur-1"])
    }

    func testStopsAtTheRequestCapRatherThanSpinning() {
        // A desktop that reports more history with an unchanging cursor is a
        // bug; it must surface as a bounded stop, not an endless request
        // stream against the transport.
        let backfill = ConversationBackfill()
        var requested: [String] = []

        for _ in 0..<50 {
            backfill.advance(tabId: "t1", hasMore: true, cursor: "stuck", isLoading: false) { c, _ in
                requested.append(c)
            }
        }

        XCTAssertEqual(requested.count, 10, "should stop at the hard request cap")
        XCTAssertFalse(backfill.isBackfilling("t1"))
    }
}

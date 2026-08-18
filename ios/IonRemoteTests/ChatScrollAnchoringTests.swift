import XCTest
@testable import IonRemote

/// Scroll-stability helpers for the conversation transcript.
///
/// Each of the three functions under test encodes one of the defects that made
/// the iOS conversation move under a user who was scrolled back reading
/// history. They are pure so the behavior can be pinned without a UIKit host,
/// window, or layout pass.
final class ChatScrollAnchoringTests: XCTestCase {

    // MARK: - shouldAutoTail

    /// The core regression. When the user is scrolled back, an incoming update
    /// must NOT scroll the view. Previously the tail decision read the
    /// `isNearBottom` @Binding, which lags one `DispatchQueue.main.async` hop
    /// behind the real scroll position, so applies landing inside that window
    /// saw a stale `true` and yanked the user to the bottom.
    func testDoesNotTailWhenScrolledBack() {
        XCTAssertFalse(
            shouldAutoTail(nearBottom: false, isUserInteracting: false, isInitial: false, forceScroll: false),
            "a scrolled-back reader must not be moved by an incoming update"
        )
    }

    /// Near the bottom but mid-gesture: let the drag/deceleration finish rather
    /// than fighting it. This guard existed before and must survive.
    func testDoesNotTailWhileUserIsInteracting() {
        XCTAssertFalse(
            shouldAutoTail(nearBottom: true, isUserInteracting: true, isInitial: false, forceScroll: false),
            "an active drag must not be interrupted by an auto-tail"
        )
    }

    /// At rest at the bottom is the one case that tails: this is the "follow the
    /// stream" behavior the user explicitly wants to keep.
    func testTailsWhenAtBottomAndIdle() {
        XCTAssertTrue(
            shouldAutoTail(nearBottom: true, isUserInteracting: false, isInitial: false, forceScroll: false),
            "sitting at the bottom must keep following new content"
        )
    }

    /// A freshly opened conversation shows its newest turn regardless of the
    /// geometry reported before any content exists.
    func testInitialApplyAlwaysTails() {
        XCTAssertTrue(
            shouldAutoTail(nearBottom: false, isUserInteracting: false, isInitial: true, forceScroll: false),
            "the first populate must land at the bottom"
        )
    }

    /// Explicit requests (prompt submit, scroll-to-bottom button, post-reconnect
    /// reload) override position — including mid-drag, because the user just
    /// asked for it.
    func testForceScrollOverridesPositionAndInteraction() {
        XCTAssertTrue(
            shouldAutoTail(nearBottom: false, isUserInteracting: false, isInitial: false, forceScroll: true),
            "an explicit scroll request must win over a scrolled-back position"
        )
        XCTAssertTrue(
            shouldAutoTail(nearBottom: false, isUserInteracting: true, isInitial: false, forceScroll: true),
            "an explicit scroll request must win even mid-gesture"
        )
    }

    // MARK: - itemsNeedingReconfigure

    /// A no-op re-apply must rebuild nothing. The previous implementation
    /// reconfigured every existing row on every apply, re-measuring rows above
    /// the viewport and shifting the reading position by a line at a time.
    func testIdenticalApplyReconfiguresNothing() {
        let items = [(id: "a", contentHash: 1), (id: "b", contentHash: 2)]
        let first = itemsNeedingReconfigure(previousHashes: [:], current: items)
        let second = itemsNeedingReconfigure(previousHashes: first.nextHashes, current: items)

        XCTAssertTrue(second.changedIds.isEmpty,
            "re-applying identical content must not reconfigure any row")
    }

    /// Only the row whose content moved is rebuilt — the streaming case.
    func testOnlyChangedRowsAreReconfigured() {
        let before = [(id: "a", contentHash: 1), (id: "b", contentHash: 2), (id: "c", contentHash: 3)]
        let seeded = itemsNeedingReconfigure(previousHashes: [:], current: before)

        // "b" streams new text; a and c are untouched.
        let after = [(id: "a", contentHash: 1), (id: "b", contentHash: 99), (id: "c", contentHash: 3)]
        let plan = itemsNeedingReconfigure(previousHashes: seeded.nextHashes, current: after)

        XCTAssertEqual(plan.changedIds, ["b"],
            "exactly the row whose content hash moved must be reconfigured")
    }

    /// A brand-new id is an insert, not a reconfigure: the data source builds
    /// its cell from scratch, and asking UIKit to reconfigure an id absent from
    /// the old snapshot is both redundant and invalid. Its hash must still be
    /// recorded so the NEXT apply can detect a change against it.
    func testNewIdIsAnInsertNotAReconfigure() {
        let seeded = itemsNeedingReconfigure(
            previousHashes: [:],
            current: [(id: "a", contentHash: 1)]
        )
        let plan = itemsNeedingReconfigure(
            previousHashes: seeded.nextHashes,
            current: [(id: "a", contentHash: 1), (id: "new", contentHash: 7)]
        )

        XCTAssertTrue(plan.changedIds.isEmpty,
            "an appended row is an insert, not a reconfigure")
        XCTAssertEqual(plan.nextHashes["new"], 7,
            "the new row's hash must be carried forward so later changes are detected")

        // Prove the carry-forward works: the same id changing next time IS a
        // reconfigure.
        let next = itemsNeedingReconfigure(
            previousHashes: plan.nextHashes,
            current: [(id: "a", contentHash: 1), (id: "new", contentHash: 8)]
        )
        XCTAssertEqual(next.changedIds, ["new"],
            "a row inserted last pass must be reconfigurable on the next change")
    }

    /// Rows dropped from the snapshot must not linger in the hash map, or a row
    /// re-added later would compare against a stale hash and skip its rebuild.
    func testRemovedRowsAreDroppedFromTheHashMap() {
        let seeded = itemsNeedingReconfigure(
            previousHashes: [:],
            current: [(id: "a", contentHash: 1), (id: "gone", contentHash: 2)]
        )
        let plan = itemsNeedingReconfigure(
            previousHashes: seeded.nextHashes,
            current: [(id: "a", contentHash: 1)]
        )

        XCTAssertNil(plan.nextHashes["gone"],
            "a row absent from the new snapshot must not persist in the hash map")
    }

    // MARK: - anchoredOffset

    /// The prepend case: an older history page lands above the viewport and
    /// pushes the anchor row down. The offset must increase by exactly that
    /// amount so the row the user is reading stays put. A diffable apply
    /// preserves contentOffset rather than reading position, which is what made
    /// pagination jump by a whole page.
    func testPrependShiftsOffsetByInsertedHeight() {
        // Anchor sat 40pt below the viewport top at offset 500 (frame.minY 540).
        // A 320pt page is inserted above it, so its minY becomes 860.
        let restored = anchoredOffset(
            previousAnchorTop: 40,
            newAnchorTop: 860,
            minOffset: 0,
            maxOffset: 5_000
        )

        XCTAssertEqual(restored, 820, accuracy: 0.001,
            "offset must advance by the inserted height so the anchor row does not move")
        // Sanity: the anchor is back at the same viewport position.
        XCTAssertEqual(860 - restored, 40, accuracy: 0.001,
            "the anchor row's on-screen position must be unchanged")
    }

    /// An unchanged layout must produce an unchanged offset — no drift on a
    /// content-only update.
    func testUnchangedLayoutLeavesOffsetPut() {
        let restored = anchoredOffset(
            previousAnchorTop: -20,
            newAnchorTop: 480,
            minOffset: 0,
            maxOffset: 5_000
        )
        XCTAssertEqual(restored, 500, accuracy: 0.001,
            "an anchor that did not move must not move the offset")
    }

    /// A row removed above the viewport shrinks content: the offset must
    /// decrease rather than leaving a gap.
    func testRemovalAboveViewportPullsOffsetBack() {
        let restored = anchoredOffset(
            previousAnchorTop: 10,
            newAnchorTop: 300,
            minOffset: 0,
            maxOffset: 5_000
        )
        XCTAssertEqual(restored, 290, accuracy: 0.001,
            "content removed above the anchor must pull the offset back")
    }

    /// Clamping: the computed target can fall outside the scrollable range when
    /// content shrinks dramatically (a heal that replaces most of the
    /// transcript). It must never produce an out-of-bounds offset.
    func testOffsetIsClampedToScrollableRange() {
        XCTAssertEqual(
            anchoredOffset(previousAnchorTop: 900, newAnchorTop: 100, minOffset: -60, maxOffset: 5_000),
            -60, accuracy: 0.001,
            "a target above the top must clamp to the top inset"
        )
        XCTAssertEqual(
            anchoredOffset(previousAnchorTop: -9_000, newAnchorTop: 100, minOffset: 0, maxOffset: 400),
            400, accuracy: 0.001,
            "a target past the bottom must clamp to the maximum offset"
        )
    }

    /// Degenerate content (shorter than the viewport, so maxOffset < minOffset)
    /// must not invert the clamp and return a nonsense offset.
    func testDegenerateContentSizeReturnsMinOffset() {
        XCTAssertEqual(
            anchoredOffset(previousAnchorTop: 40, newAnchorTop: 800, minOffset: 0, maxOffset: -50),
            0, accuracy: 0.001,
            "content shorter than the viewport must resolve to the top, not an inverted clamp"
        )
    }
}

import XCTest
@testable import IonRemote

/// PagedPreviewState — pins the share/save-target-correctness fix in the
/// paged image preview.
///
/// ── The bug this pins ───────────────────────────────────────────────────────
/// The original design held one `pagedImage: UIImage?`, written only when
/// `pageIndex == index` (the page reporting a resolve happened to be the one
/// currently on screen). Two ways that silently exported the wrong image:
///
///   1. Swipe forward, then back to a page that already resolved. The page's
///      `loadIfNeeded` early-returns once its own `image` state is non-nil, so
///      it never reports again — `pagedImage` is stuck holding whatever the
///      LAST page to report resolved, not the page now on screen.
///   2. A cache-miss fetch that lands after the user has swiped past that
///      page. The `pageIndex == index` check fails at delivery time, the
///      resolve is dropped, and because the page never re-fetches, it is
///      dropped permanently — Share stays disabled for a page that is
///      visibly rendered with an image.
///
/// `PagedPreviewState` fixes this by keying every resolve by page index and
/// reading the share target back by whichever index is current, rather than
/// gating the write on real-time index equality.
///
/// Revert contract: reintroducing an `if pageIndex == index` write-gate (or a
/// single non-keyed `UIImage?`) fails
/// `testResolvingOutOfOrderStillExportsTheCurrentPage`.
final class PagedPreviewStateTests: XCTestCase {

    private func makeImage(color: UIColor) -> UIImage {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 2, height: 2))
        return renderer.image { ctx in
            color.setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: 2, height: 2))
        }
    }

    func testUnresolvedPageHasNoCurrentImage() {
        let state = PagedPreviewState()
        XCTAssertNil(state.current(index: 0))
    }

    func testResolvedPageIsRetrievableByItsOwnIndex() {
        var state = PagedPreviewState()
        let img = makeImage(color: .red)
        state.record(img, at: 2)
        XCTAssertEqual(state.current(index: 2), img)
        XCTAssertNil(state.current(index: 0))
    }

    func testResolvingOutOfOrderStillExportsTheCurrentPage() {
        // Reproduces failure mode #2: page 1's fetch lands AFTER the user has
        // already swiped to page 0. The old design would have dropped this
        // resolve entirely (pageIndex(1) != index(0) at delivery time). Here
        // it must simply be recorded and retrievable once the user swipes
        // back to page 1 — nothing is lost.
        var state = PagedPreviewState()
        let page0Image = makeImage(color: .blue)
        let page1Image = makeImage(color: .green)

        state.record(page0Image, at: 0)
        // Simulate page 1's resolve landing while page 0 is on screen.
        state.record(page1Image, at: 1)

        // Currently on page 0 — share target is page 0's image, not page 1's.
        XCTAssertEqual(state.current(index: 0), page0Image)
        // User swipes to page 1 — its resolve was recorded, not dropped.
        XCTAssertEqual(state.current(index: 1), page1Image)
    }

    func testRevisitingAnAlreadyResolvedPageKeepsItsOwnImage() {
        // Reproduces failure mode #1: swipe 0 -> 1 -> 0. Page 0's image must
        // still be page 0's image, not overwritten by page 1's later resolve.
        var state = PagedPreviewState()
        let page0Image = makeImage(color: .red)
        let page1Image = makeImage(color: .yellow)

        state.record(page0Image, at: 0)
        state.record(page1Image, at: 1)

        XCTAssertEqual(state.current(index: 0), page0Image)
        XCTAssertEqual(state.current(index: 1), page1Image)
        XCTAssertNotEqual(state.current(index: 0), state.current(index: 1))
    }
}

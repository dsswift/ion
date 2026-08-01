import XCTest
@testable import IonRemote

/// MessageAttachmentGallery cap arithmetic.
///
/// The gallery exists because a many-image turn used to render one full-width
/// thumbnail per image, burying the transcript. The cap is what bounds it, and
/// it must fold at the same point the desktop folds at
/// (`galleryLayout` in `desktop/src/renderer/components/conversation/ImageGallery.tsx`)
/// — otherwise the same conversation reads differently per device.
///
/// Revert contract: returning `count` unconditionally, or spending all `railCap`
/// slots on images and hiding the remainder, fails these assertions.
final class MessageAttachmentGalleryTests: XCTestCase {

    func testShowsEverythingBelowTheCap() {
        let single = galleryLayout(count: 1, expanded: false)
        XCTAssertEqual(single.visible, 1)
        XCTAssertEqual(single.overflow, 0)

        let atCap = galleryLayout(count: MessageAttachmentGallery.railCap, expanded: false)
        XCTAssertEqual(atCap.visible, MessageAttachmentGallery.railCap)
        XCTAssertEqual(atCap.overflow, 0)
    }

    func testSpendsTheLastSlotOnTheOverflowTile() {
        // 50 images: 11 tiles + "+39 more". Never 12 tiles with 38 unreachable.
        let many = galleryLayout(count: 50, expanded: false)
        XCTAssertEqual(many.visible, 11)
        XCTAssertEqual(many.overflow, 39)

        let justOver = galleryLayout(count: MessageAttachmentGallery.railCap + 1, expanded: false)
        XCTAssertEqual(justOver.visible, MessageAttachmentGallery.railCap - 1)
        XCTAssertEqual(justOver.overflow, 2)
    }

    func testExpandedShowsEveryImage() {
        let expanded = galleryLayout(count: 50, expanded: true)
        XCTAssertEqual(expanded.visible, 50)
        XCTAssertEqual(expanded.overflow, 0)
    }

    func testVisiblePlusOverflowAlwaysAccountsForEveryImage() {
        // No image is ever dropped: what is not painted is counted in the
        // overflow affordance, which is the only way to reach it.
        for count in 0...60 {
            let layout = galleryLayout(count: count, expanded: false)
            XCTAssertEqual(layout.visible + layout.overflow, count, "count \(count) lost images")
        }
    }
}

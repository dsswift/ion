import XCTest
@testable import IonRemote

/// MessageAttachmentGallery cap arithmetic.
///
/// The gallery exists because a many-image turn used to render one full-width
/// thumbnail per image, burying the transcript. The cap is what bounds it, and
/// it must fold at the same point the desktop folds at
/// (`galleryLayout` in `desktop/src/renderer/components/conversation/ImageGallery.tsx`)
/// — otherwise the same conversation reads differently per device. Enforced
/// directly by `testRailCapMatchesSharedParityFixture` below.
///
/// Revert contract: returning `count` unconditionally, or spending all `railCap`
/// slots on images and hiding the remainder, fails these assertions.
final class MessageAttachmentGalleryTests: XCTestCase {

    func testShowsEverythingBelowTheCap() {
        let single = MessageAttachmentGallery.layout(count: 1, expanded: false)
        XCTAssertEqual(single.visible, 1)
        XCTAssertEqual(single.overflow, 0)

        let atCap = MessageAttachmentGallery.layout(count: MessageAttachmentGallery.railCap, expanded: false)
        XCTAssertEqual(atCap.visible, MessageAttachmentGallery.railCap)
        XCTAssertEqual(atCap.overflow, 0)
    }

    func testSpendsTheLastSlotOnTheOverflowTile() {
        // 50 images: 11 tiles + "+39 more". Never 12 tiles with 38 unreachable.
        let many = MessageAttachmentGallery.layout(count: 50, expanded: false)
        XCTAssertEqual(many.visible, 11)
        XCTAssertEqual(many.overflow, 39)

        let justOver = MessageAttachmentGallery.layout(count: MessageAttachmentGallery.railCap + 1, expanded: false)
        XCTAssertEqual(justOver.visible, MessageAttachmentGallery.railCap - 1)
        XCTAssertEqual(justOver.overflow, 2)
    }

    func testExpandedShowsEveryImage() {
        let expanded = MessageAttachmentGallery.layout(count: 50, expanded: true)
        XCTAssertEqual(expanded.visible, 50)
        XCTAssertEqual(expanded.overflow, 0)
    }

    func testVisiblePlusOverflowAlwaysAccountsForEveryImage() {
        // No image is ever dropped: what is not painted is counted in the
        // overflow affordance, which is the only way to reach it.
        for count in 0...60 {
            let layout = MessageAttachmentGallery.layout(count: count, expanded: false)
            XCTAssertEqual(layout.visible + layout.overflow, count, "count \(count) lost images")
        }
    }

    // MARK: - Cross-platform parity

    /// Asserts `railCap` against the shared fixture (repo-root
    /// `assets/gallery-parity.json`) that
    /// `ImageGallery.test.tsx` asserts `GALLERY_RAIL_CAP` against on the
    /// desktop side. Drift on either side fails that side's build instead of
    /// silently folding a many-image conversation at a different point per
    /// device. Fixture-loading idiom matches `ThemeParityTests.swift`.
    func testRailCapMatchesSharedParityFixture() throws {
        let fixture = try loadGalleryParityFixture()
        XCTAssertEqual(MessageAttachmentGallery.railCap, fixture.railCap)
    }

    private struct GalleryParityFixture: Decodable {
        let railCap: Int
    }

    private enum GalleryParityError: Error {
        case fixtureNotFound
    }

    private func loadGalleryParityFixture() throws -> GalleryParityFixture {
        let candidates = [
            "../assets/gallery-parity.json",   // cwd = ios/
            "assets/gallery-parity.json",       // cwd = repo root
        ]
        for candidate in candidates {
            let url = URL(fileURLWithPath: candidate)
            if FileManager.default.fileExists(atPath: url.path) {
                return try JSONDecoder().decode(GalleryParityFixture.self, from: Data(contentsOf: url))
            }
        }
        // Fallback: search up from this source file's location.
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<5 {
            dir = dir.deletingLastPathComponent()
            let candidate = dir.appendingPathComponent("assets/gallery-parity.json")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try JSONDecoder().decode(GalleryParityFixture.self, from: Data(contentsOf: candidate))
            }
        }
        throw GalleryParityError.fixtureNotFound
    }
}

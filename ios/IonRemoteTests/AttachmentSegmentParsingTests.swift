import XCTest
@testable import IonRemote

/// Tests for parseAttachmentSegments — the function that splits user-message
/// content into inline image paths and display text.
///
/// Two marker forms exist in practice:
///   1. `[Attached image: PATH]` — written by submit() on iOS before the
///      desktop encodes the attachment. The path is extractable.
///   2. `[Attachment: NAME (content attached)]` — written by attachment-
///      encoder.ts after the image is base64-encoded and sent to the engine.
///      No path is embedded; strip it so it never renders as literal text.
final class AttachmentSegmentParsingTests: XCTestCase {

    // MARK: - Form 1: [Attached image: PATH]

    func testAttachedImageMarkerExtractsPath() {
        let raw = "[Attached image: /tmp/photo.jpg]\n\nwhat is this?"
        let result = parseAttachmentSegments(raw)
        XCTAssertEqual(result.images, ["/tmp/photo.jpg"])
        XCTAssertEqual(result.text, "what is this?")
    }

    func testAttachedImageMarkerOnlyProducesEmptyText() {
        let raw = "[Attached image: /tmp/photo.jpg]"
        let result = parseAttachmentSegments(raw)
        XCTAssertEqual(result.images, ["/tmp/photo.jpg"])
        XCTAssertEqual(result.text, "")
    }

    func testMultipleAttachedImageMarkers() {
        let raw = "[Attached image: /a.png]\n[Attached image: /b.png]\n\nlook at these"
        let result = parseAttachmentSegments(raw)
        XCTAssertEqual(result.images, ["/a.png", "/b.png"])
        XCTAssertEqual(result.text, "look at these")
    }

    // MARK: - Form 2: [Attachment: NAME (content attached)]

    func testContentAttachedMarkerStrippedNoImages() {
        let raw = "[Attachment: photo.jpg (content attached)]\n\nwhat is this?"
        let result = parseAttachmentSegments(raw)
        // No path is extractable from the rewritten form.
        XCTAssertTrue(result.images.isEmpty, "rewritten marker must not produce image paths")
        XCTAssertEqual(result.text, "what is this?",
            "rewritten marker must be stripped, not rendered as literal text")
    }

    func testContentAttachedMarkerOnlyProducesEmptyText() {
        let raw = "[Attachment: photo.jpg (content attached)]"
        let result = parseAttachmentSegments(raw)
        XCTAssertTrue(result.images.isEmpty)
        XCTAssertEqual(result.text, "")
    }

    func testMultipleContentAttachedMarkersStripped() {
        let raw = "[Attachment: a.jpg (content attached)]\n[Attachment: b.png (content attached)]\n\nhere are the images"
        let result = parseAttachmentSegments(raw)
        XCTAssertTrue(result.images.isEmpty)
        XCTAssertEqual(result.text, "here are the images")
    }

    // MARK: - Mixed: both forms in one message

    func testMixedMarkersExtractPathAndStripsRewritten() {
        // The optimistic echo from tabs-prompt.ts uses fullText which may
        // contain the original [Attached image: PATH] form; after a history
        // reload the engine-persisted form is [Attachment: NAME (content attached)].
        // A message should not normally have both, but the parser must handle it.
        let raw = "[Attached image: /tmp/a.jpg]\n[Attachment: b.jpg (content attached)]\n\nsome text"
        let result = parseAttachmentSegments(raw)
        XCTAssertEqual(result.images, ["/tmp/a.jpg"])
        XCTAssertEqual(result.text, "some text")
    }

    // MARK: - No markers

    func testNoMarkersPassesThrough() {
        let raw = "just a plain message with no attachments"
        let result = parseAttachmentSegments(raw)
        XCTAssertTrue(result.images.isEmpty)
        XCTAssertEqual(result.text, raw)
    }

    func testEmptyStringPassesThrough() {
        let result = parseAttachmentSegments("")
        XCTAssertTrue(result.images.isEmpty)
        XCTAssertEqual(result.text, "")
    }
}

import XCTest
@testable import IonRemote

/// Pins that a user message has one rendering. A second, compact bubble used
/// while a turn ran drew only images named by a path marker in the text, so a
/// prompt sent with a structured image attachment lost its picture until the
/// turn finished.
final class UserBubbleAttachmentTests: XCTestCase {

    private func source(_ relativePath: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent(relativePath)
        return try String(contentsOf: url, encoding: .utf8)
    }

    func testThereIsNoSecondUserBubble() throws {
        let row = try source("IonRemote/Views/EngineMessageRow.swift")
        XCTAssertFalse(row.contains("engineUserBubble"), "a second user bubble must not return")
        XCTAssertTrue(row.contains("MessageAttachmentImages(attachments: attachments"),
                      "the user bubble renders the message's structured attachments")
    }

    /// The stored form of a prompt sent with an image: no path to recover from
    /// the text, so the structured attachment is the only carrier.
    func testContentAttachedMarkerCarriesNoImagePath() {
        let segments = parseAttachmentSegments("[Attachment: shot.jpeg (content attached)]\n\nlook at this")
        XCTAssertTrue(segments.images.isEmpty)
        XCTAssertEqual(segments.text, "look at this")
    }
}

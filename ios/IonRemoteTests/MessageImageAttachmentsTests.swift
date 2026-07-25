import XCTest
@testable import IonRemote

/// Pins `Message.imageAttachments`, the seam the assistant and tool bubbles in
/// `EngineMessageRow` gate on to render engine-generated images inline.
///
/// Regression context: a provider-generated image (e.g. an image-model turn)
/// attaches to the ASSISTANT message and a tool-returned image to the TOOL
/// message — never to a user message, and usually on an empty-content turn.
/// The bubbles previously rendered only `message.content`, so the image turn
/// showed as a blank row on iOS while the desktop showed the image. These
/// assertions go red if the helper stops surfacing image attachments on
/// non-user roles.
final class MessageImageAttachmentsTests: XCTestCase {
    private func decode(_ json: String) throws -> Message {
        try JSONDecoder().decode(Message.self, from: Data(json.utf8))
    }

    func testProviderImageOnAssistantMessageIsSurfaced() throws {
        let msg = try decode("""
        {"id":"m1","role":"assistant","content":"",
         "attachments":[{"id":"img:/p.png","type":"image","name":"puppy.png","path":"/img/p.png"}],
         "timestamp":0}
        """)
        XCTAssertEqual(msg.imageAttachments.map(\.path), ["/img/p.png"])
    }

    func testToolReturnedImageIsSurfaced() throws {
        let msg = try decode("""
        {"id":"m2","role":"tool","content":"","toolName":"GenerateImage",
         "attachments":[{"id":"img:/out.png","type":"image","name":"out.png","path":"/img/out.png"}],
         "timestamp":0}
        """)
        XCTAssertEqual(msg.imageAttachments.map(\.path), ["/img/out.png"])
    }

    func testNonImageAttachmentsAreExcluded() throws {
        let msg = try decode("""
        {"id":"m3","role":"assistant","content":"here",
         "attachments":[{"id":"f1","type":"file","name":"notes.txt","path":"/x/notes.txt"}],
         "timestamp":0}
        """)
        XCTAssertTrue(msg.imageAttachments.isEmpty)
    }

    func testMessageWithNoAttachmentsIsEmpty() throws {
        let msg = try decode(#"{"id":"m4","role":"user","content":"hi","timestamp":0}"#)
        XCTAssertTrue(msg.imageAttachments.isEmpty)
    }
}

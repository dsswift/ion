import XCTest
@testable import IonRemote

/// Pins the image-model disclosure-banner visibility gate.
///
/// The banner ("Image model — only this message is sent") must appear only
/// while the user is actively composing with an image-generation model
/// selected: model is an image model AND (input focused OR non-empty draft).
/// The original implementation showed it whenever an image model was selected,
/// permanently occupying input-bar space on the phone even while the user was
/// just reading the conversation — the "annoyingly large and always visible"
/// report. The pure
/// `ConversationView.computeShowImageModelBanner(isImageModel:isInputFocused:promptText:)`
/// helper makes the gate testable without instantiating the SwiftUI view
/// (same pattern as computeCanAbort / InputBarAbortGateTests).
final class InputBarImageBannerGateTests: XCTestCase {

    func testHiddenWhenNotImageModel() {
        // A chat model never shows the banner, composing or not.
        XCTAssertFalse(ConversationView.computeShowImageModelBanner(isImageModel: false, isInputFocused: true, promptText: "draw a cat"))
        XCTAssertFalse(ConversationView.computeShowImageModelBanner(isImageModel: false, isInputFocused: false, promptText: ""))
    }

    func testHiddenWhenImageModelButIdle() {
        // The regression this gate fixes: image model selected, user not
        // composing (unfocused, empty draft) — banner must NOT render.
        XCTAssertFalse(ConversationView.computeShowImageModelBanner(isImageModel: true, isInputFocused: false, promptText: ""))
    }

    func testVisibleWhenImageModelAndFocused() {
        XCTAssertTrue(ConversationView.computeShowImageModelBanner(isImageModel: true, isInputFocused: true, promptText: ""))
    }

    func testVisibleWhenImageModelAndDraftNonEmpty() {
        // A saved draft keeps the disclosure visible even after focus is lost —
        // the pending message is still the one the single-prompt semantics
        // apply to.
        XCTAssertTrue(ConversationView.computeShowImageModelBanner(isImageModel: true, isInputFocused: false, promptText: "draw a cat"))
    }

    func testVisibleWhenImageModelFocusedAndDraftNonEmpty() {
        XCTAssertTrue(ConversationView.computeShowImageModelBanner(isImageModel: true, isInputFocused: true, promptText: "draw a cat"))
    }
}

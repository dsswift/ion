import XCTest
@testable import IonRemote

/// Pins the composer's pure decisions: which control holds the trailing slot,
/// what the field's placeholder says per dictation phase, what the activity
/// strip reads, and the dictation strip's geometry.
final class ComposerStateTests: XCTestCase {

    // MARK: - Trailing slot

    func testEmptyComposerOffersTheMicrophone() {
        XCTAssertEqual(
            ComposerTrailingControl.resolve(isDictating: false, hasText: false, hasAttachments: false),
            .microphone
        )
    }

    func testTextOrAttachmentsOfferSend() {
        XCTAssertEqual(ComposerTrailingControl.resolve(isDictating: false, hasText: true, hasAttachments: false), .send)
        XCTAssertEqual(ComposerTrailingControl.resolve(isDictating: false, hasText: false, hasAttachments: true), .send)
    }

    /// An attachment or a draft adds Send; it must not take the mic away.
    func testMicrophoneStaysAvailableOnceThereIsSomethingToSend() {
        XCTAssertTrue(ComposerTrailingControl.resolve(isDictating: false, hasText: false, hasAttachments: true).showsMicrophone)
        XCTAssertTrue(ComposerTrailingControl.resolve(isDictating: false, hasText: true, hasAttachments: false).showsMicrophone)
        XCTAssertTrue(ComposerTrailingControl.resolve(isDictating: false, hasText: false, hasAttachments: false).showsMicrophone)
        XCTAssertFalse(ComposerTrailingControl.resolve(isDictating: true, hasText: true, hasAttachments: true).showsMicrophone)
    }

    func testDictationWinsRegardlessOfContent() {
        XCTAssertEqual(ComposerTrailingControl.resolve(isDictating: true, hasText: false, hasAttachments: false), .dictation)
        XCTAssertEqual(ComposerTrailingControl.resolve(isDictating: true, hasText: true, hasAttachments: true), .dictation)
    }

    // MARK: - Placeholder

    func testPlaceholderNamesEveryNonIdlePhase() {
        XCTAssertEqual(ComposerTrailingControl.placeholder(for: .idle), "Message")
        XCTAssertEqual(ComposerTrailingControl.placeholder(for: .starting), "Starting microphone…")
        XCTAssertEqual(ComposerTrailingControl.placeholder(for: .listening), "Listening…")
        XCTAssertEqual(ComposerTrailingControl.placeholder(for: .finishing), "Finishing…")
    }

    // MARK: - Activity strip

    func testWorkingMessageReplacesTheGenericRunningLabel() {
        let running = ConversationStatusBar.resolveRunActivity(isRunning: true, runningAgentCount: 0)
        XCTAssertEqual(ConversationActivityStrip.label(activity: running, workingMessage: "Reading files…"), "Reading files…")
        XCTAssertEqual(ConversationActivityStrip.label(activity: running, workingMessage: ""), "running")
    }

    func testWaitingLabelsKeepTheirCounts() {
        let waiting = ConversationStatusBar.resolveRunActivity(isRunning: false, runningAgentCount: 2)
        // A stale working message from the finished turn must not override a
        // waiting state; the count is the information.
        XCTAssertEqual(ConversationActivityStrip.label(activity: waiting, workingMessage: "Reading files…"), "waiting for 2 agents")
    }

    // MARK: - Dictation strip

    func testBarHeightStaysWithinItsRangeAndLiftsQuietSpeech() {
        XCTAssertEqual(DictationStrip.barHeight(for: 0), 3)
        XCTAssertEqual(DictationStrip.barHeight(for: 1), 18)
        XCTAssertEqual(DictationStrip.barHeight(for: 2), 18, "clamped")
        XCTAssertGreaterThan(DictationStrip.barHeight(for: 0.25), 3 + 0.25 * 15, "quiet input is lifted above linear")
    }

    func testElapsedLabelIsMinutesAndZeroPaddedSeconds() {
        let start = Date(timeIntervalSince1970: 1_000)
        XCTAssertEqual(DictationStrip.elapsedLabel(from: start, to: start.addingTimeInterval(7)), "0:07")
        XCTAssertEqual(DictationStrip.elapsedLabel(from: start, to: start.addingTimeInterval(67)), "1:07")
        XCTAssertEqual(DictationStrip.elapsedLabel(from: start, to: start.addingTimeInterval(-3)), "0:00")
    }
}

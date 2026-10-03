import XCTest
@testable import IonRemote

/// Pins the dictation session the composer runs on: one owner for the
/// recording state, finished words taken from the recognizer's commit rather
/// than its last guess, and a draft that is restored, kept, or finished
/// according to how the session ends.
///
/// The three defects this guards against, each of which the previous
/// view-owned flow had:
///
///   1. Stop discarded the engine's final result. The composer called
///      `cancelRecording` for its Done button and kept whatever the field
///      showed, which for a progressive recognizer is the volatile guess.
///      `finishDictation` must return the FINAL text the engine hands back.
///   2. The composer's recording flag drifted from the engine. An engine that
///      ended its own session (interruption, error, time limit) left the view
///      showing a strip whose Done button had nothing to stop.
///      `settleAfterEngineEnded` closes the session and keeps the words.
///   3. Cancel restored a snapshot the view kept beside the draft. The base
///      draft now lives on the session and Cancel returns exactly it.
@MainActor
final class DictationSessionTests: XCTestCase {

    // MARK: - Fakes

    /// A speech engine the test drives by hand. `finalTranscript` is what
    /// `stopRecording` returns; it may differ from the live `transcript` to
    /// model the recognizer's post-stop commit.
    @Observable
    final class FakeSpeechEngine: SpeechEngine {
        var isRecording = false
        var transcript = ""
        var audioLevel: Float = 0
        var errorMessage: String?

        var finalTranscript = ""
        var startError: Error?
        var startCount = 0
        var stopCount = 0
        var cancelCount = 0

        func startRecording() async throws {
            startCount += 1
            if let startError { throw startError }
            transcript = ""
            isRecording = true
        }

        func stopRecording() async -> String {
            stopCount += 1
            isRecording = false
            return finalTranscript
        }

        func cancelRecording() {
            cancelCount += 1
            isRecording = false
            transcript = ""
        }

        /// The engine ended the session itself.
        func endUnexpectedly() {
            isRecording = false
        }
    }

    final class GrantedPermissions: SpeechPermissionManager {
        override var isFullyGranted: Bool { true }
        override var isDenied: Bool { false }
    }

    final class RefusedPermissions: SpeechPermissionManager {
        override var isFullyGranted: Bool { false }
        override var isDenied: Bool { true }
    }

    private func makeService(engine: FakeSpeechEngine, granted: Bool = true) -> SpeechRecognitionService {
        SpeechRecognitionService(
            engine: engine,
            permissions: granted ? GrantedPermissions() : RefusedPermissions()
        )
    }

    // MARK: - Composition

    func testComposeJoinsBaseAndSpokenWithOneSpace() {
        XCTAssertEqual(SpeechRecognitionService.compose(base: "Fix the", transcript: " login bug"), "Fix the login bug")
        XCTAssertEqual(SpeechRecognitionService.compose(base: "Fix the ", transcript: "login bug"), "Fix the login bug")
        XCTAssertEqual(SpeechRecognitionService.compose(base: "", transcript: "  login bug  "), "login bug")
        XCTAssertEqual(SpeechRecognitionService.compose(base: "Fix the", transcript: "   "), "Fix the")
    }

    // MARK: - Session lifecycle

    func testBeginDictationOpensListeningSessionOverBaseDraft() async throws {
        let engine = FakeSpeechEngine()
        let service = makeService(engine: engine)

        try await service.beginDictation(baseDraft: "Please")
        engine.transcript = "add tests"

        XCTAssertEqual(service.phase, .listening)
        XCTAssertNotNil(service.startedAt)
        XCTAssertEqual(service.baseDraft, "Please")
        XCTAssertEqual(service.composedDraft, "Please add tests")
        XCTAssertEqual(engine.startCount, 1)
    }

    func testFinishReturnsTheEnginesFinalTextNotTheLiveGuess() async throws {
        let engine = FakeSpeechEngine()
        let service = makeService(engine: engine)
        try await service.beginDictation(baseDraft: "")
        engine.transcript = "ship the fixed"            // volatile guess at the tap
        engine.finalTranscript = "ship the fix today"   // what the recognizer commits after stop

        let composed = await service.finishDictation()

        XCTAssertEqual(composed, "ship the fix today")
        XCTAssertEqual(service.phase, .idle)
        XCTAssertNil(service.startedAt)
        XCTAssertEqual(engine.stopCount, 1)
        XCTAssertEqual(engine.cancelCount, 0, "Done must finalize, never cancel")
    }

    func testCancelRestoresExactlyTheBaseDraft() async throws {
        let engine = FakeSpeechEngine()
        let service = makeService(engine: engine)
        try await service.beginDictation(baseDraft: "Keep this")
        engine.transcript = "and lose this"

        let restored = service.cancelDictation()

        XCTAssertEqual(restored, "Keep this")
        XCTAssertEqual(service.phase, .idle)
        XCTAssertEqual(engine.cancelCount, 1)
    }

    func testEngineEndingOnItsOwnClosesTheSessionAndKeepsTheWords() async throws {
        let engine = FakeSpeechEngine()
        let service = makeService(engine: engine)
        try await service.beginDictation(baseDraft: "Note:")
        engine.transcript = "the call dropped"
        engine.endUnexpectedly()

        let composed = service.settleAfterEngineEnded()

        XCTAssertEqual(composed, "Note: the call dropped")
        XCTAssertEqual(service.phase, .idle, "no stuck recording strip")
        XCTAssertFalse(service.isDictating)
    }

    func testRefusedPermissionThrowsAndLeavesTheSessionIdle() async {
        let engine = FakeSpeechEngine()
        let service = makeService(engine: engine, granted: false)

        do {
            try await service.beginDictation(baseDraft: "")
            XCTFail("expected permissionDenied")
        } catch {
            XCTAssertEqual(service.phase, .idle)
            XCTAssertEqual(engine.startCount, 0)
        }
    }

    func testEngineStartFailureLeavesTheSessionIdle() async {
        let engine = FakeSpeechEngine()
        engine.startError = SpeechEngineError.recognizerUnavailable
        let service = makeService(engine: engine)

        do {
            try await service.beginDictation(baseDraft: "x")
            XCTFail("expected the engine's error")
        } catch {
            XCTAssertEqual(service.phase, .idle)
            XCTAssertNil(service.startedAt)
        }
    }

    // MARK: - Draft writes through the view model

    private func makeViewModel(engine: FakeSpeechEngine) -> (SessionViewModel, String) {
        let vm = SessionViewModel()
        vm.speechService = makeService(engine: engine)
        let tabId = "dictation-\(UUID().uuidString)"
        return (vm, tabId)
    }

    func testLiveTranscriptIsMirroredIntoTheDraftWhileListening() async {
        let engine = FakeSpeechEngine()
        let (vm, tabId) = makeViewModel(engine: engine)
        defer { vm.clearTabDraft(tabId) }
        vm.setTabDraft(tabId, "Start", broadcast: false)

        let outcome = await vm.startDictation(tabId: tabId)
        XCTAssertEqual(outcome, .started)

        engine.transcript = "here"
        vm.syncDictationDraft(tabId: tabId)
        XCTAssertEqual(vm.tabDraft(tabId), "Start here")
    }

    func testFinishWritesTheFinalTextAndLaterTranscriptChangesAreIgnored() async {
        let engine = FakeSpeechEngine()
        let (vm, tabId) = makeViewModel(engine: engine)
        defer { vm.clearTabDraft(tabId) }
        _ = await vm.startDictation(tabId: tabId)
        engine.transcript = "deploy to stagin"
        vm.syncDictationDraft(tabId: tabId)
        engine.finalTranscript = "deploy to staging"

        await vm.finishDictation(tabId: tabId)
        XCTAssertEqual(vm.tabDraft(tabId), "deploy to staging")

        // A late result from the closed session must not reopen the draft.
        engine.transcript = "deploy to staging now"
        vm.syncDictationDraft(tabId: tabId)
        XCTAssertEqual(vm.tabDraft(tabId), "deploy to staging")
    }

    func testCancelPutsThePreDictationDraftBack() async {
        let engine = FakeSpeechEngine()
        let (vm, tabId) = makeViewModel(engine: engine)
        defer { vm.clearTabDraft(tabId) }
        vm.setTabDraft(tabId, "Original", broadcast: false)
        _ = await vm.startDictation(tabId: tabId)
        engine.transcript = "replaced"
        vm.syncDictationDraft(tabId: tabId)
        XCTAssertEqual(vm.tabDraft(tabId), "Original replaced")

        vm.cancelDictation(tabId: tabId)
        XCTAssertEqual(vm.tabDraft(tabId), "Original")
    }

    func testEngineEndedKeepsTheWordsInTheDraft() async {
        let engine = FakeSpeechEngine()
        let (vm, tabId) = makeViewModel(engine: engine)
        defer { vm.clearTabDraft(tabId) }
        _ = await vm.startDictation(tabId: tabId)
        engine.transcript = "half a thought"
        vm.syncDictationDraft(tabId: tabId)
        engine.endUnexpectedly()

        vm.dictationEngineEnded(tabId: tabId)
        XCTAssertEqual(vm.tabDraft(tabId), "half a thought")
        XCTAssertFalse(vm.speechService.isDictating)

        // Idempotent: a second notice (the view observing the same flip) does nothing.
        vm.dictationEngineEnded(tabId: tabId)
        XCTAssertEqual(vm.tabDraft(tabId), "half a thought")
    }
}

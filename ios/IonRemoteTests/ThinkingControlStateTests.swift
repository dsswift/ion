import XCTest
@testable import IonRemote

/// Two things are pinned here.
///
/// 1. `ThinkingControlState.resolve` — the pure rendering rules. Four cases:
///    adaptive floor, efforts without an adaptive floor, no efforts at all, and
///    a model absent from `availableModels` entirely.
///
/// 2. THE CONTROL IS NEVER HIDDEN. This is the defect the change fixes. The
///    pre-fix `ConversationStatusBar` computed
///    `showThinkingControl = thinkingGloballyEnabled && !thinkingEfforts.isEmpty`
///    and wrapped the whole menu in `if showThinkingControl`, so the slot
///    vanished for a model with no declared efforts. The regression tests below
///    assert the resolver reports a RENDERABLE-but-DISABLED control for exactly
///    those inputs — the pre-fix predicate returns false where these assert
///    `enabled == false` AND a non-empty `levels` list plus an honest label,
///    which is what the view now renders unconditionally.
///
/// The `"thinkingMode": "adaptive"` fixture in `ThinkingEffortCodecTests` is
/// reused here (`testAdaptiveFixtureResolvesToAdaptiveLabel`) rather than
/// writing a second one, so the decode path and the rendering path are pinned
/// against the same JSON.
final class ThinkingControlStateTests: XCTestCase {

    // MARK: - Resolver

    func testAdaptiveFloorReadsAdaptiveAndIsEnabled() {
        let s = ThinkingControlState.resolve(thinkingMode: "adaptive", thinkingEfforts: ["low", "medium", "high"])
        XCTAssertEqual(s.offLabel, "Adaptive")
        XCTAssertTrue(s.enabled)
        XCTAssertEqual(s.levels.map(\.value), ["adaptive", "low", "medium", "high"])
        // "Adaptive" REPLACES "Off" — it is not a fifth entry.
        XCTAssertEqual(s.levels.filter { $0.value == "adaptive" }.count, 1)
        XCTAssertFalse(s.levels.map(\.label).contains("Off"))
    }

    func testEffortsWithoutAdaptiveFloorReadsOffAndIsEnabled() {
        let s = ThinkingControlState.resolve(thinkingMode: "reasoning_effort", thinkingEfforts: ["low", "high"])
        XCTAssertEqual(s.offLabel, "Off")
        XCTAssertTrue(s.enabled)
        // Only the levels the model declares — medium is absent here.
        XCTAssertEqual(s.levels.map(\.value), ["off", "low", "high"])
    }

    func testNoEffortsIsDisabledButStillRenderable() {
        let s = ThinkingControlState.resolve(thinkingMode: "none", thinkingEfforts: [])
        XCTAssertFalse(s.enabled)
        XCTAssertEqual(s.offLabel, "Off")
        // Renderable: there is still a row and a label, so the view has
        // something honest to draw instead of removing itself.
        XCTAssertEqual(s.levels.map(\.value), ["off"])
    }

    func testModelAbsentFromAvailableModelsIsDisabledAndDoesNotCrash() {
        let s = ThinkingControlState.resolve(thinkingMode: nil, thinkingEfforts: nil)
        XCTAssertFalse(s.enabled)
        XCTAssertEqual(s.offLabel, "Off")
        XCTAssertEqual(s.levels.map(\.value), ["off"])
    }

    func testAdaptiveWithNoDeclaredOverrideLevelsIsStillDisabled() {
        // Nothing to choose between, so there is no menu to open — but the
        // trigger reports the honest floor.
        let s = ThinkingControlState.resolve(thinkingMode: "adaptive", thinkingEfforts: [])
        XCTAssertFalse(s.enabled)
        XCTAssertEqual(s.offLabel, "Adaptive")
    }

    func testNonAdaptiveModesAllReadOff() {
        // "budget", "reasoning_effort", and "gemini" declare effort levels but
        // no always-on floor: their "off" row means thinking is genuinely off.
        for mode in ["budget", "reasoning_effort", "gemini"] {
            let s = ThinkingControlState.resolve(thinkingMode: mode, thinkingEfforts: ["low", "high"])
            XCTAssertEqual(s.offLabel, "Off", "mode \(mode) must not claim an adaptive floor")
            XCTAssertTrue(s.enabled)
        }
    }

    func testPreservesEveryAdvertisedOverrideLevelInCanonicalOrder() {
        let s = ThinkingControlState.resolve(
            thinkingMode: "reasoning_effort",
            thinkingEfforts: ["max", "xhigh", "low"]
        )
        XCTAssertEqual(s.levels.map(\.value), ["off", "low", "xhigh", "max"])
    }

    func testTriggerLabelFollowsSelectedEffortAndFallsBackToOffRow() {
        let adaptive = ThinkingControlState.resolve(thinkingMode: "adaptive", thinkingEfforts: ["low", "high"])
        XCTAssertEqual(adaptive.triggerLabel(for: "adaptive"), "Adaptive")
        XCTAssertEqual(adaptive.triggerLabel(for: "high"), "High")
        // "medium" is not declared by this model: fall back to the off row
        // rather than rendering an empty label.
        XCTAssertEqual(adaptive.triggerLabel(for: "medium"), "Adaptive")
        // An unrecognized stored value does the same, instead of silently
        // claiming thinking is off for an adaptive model.
        XCTAssertEqual(adaptive.triggerLabel(for: "bogus"), "Adaptive")
    }

    // MARK: - Never hidden

    /// Reuses the `"thinkingMode": "adaptive"` fixture from
    /// `ThinkingEffortCodecTests` so decode and rendering are pinned against
    /// one JSON payload.
    func testAdaptiveFixtureResolvesToAdaptiveLabel() throws {
        let json = """
        { "id": "claude-sonnet-4-6", "providerId": "anthropic", "label": "Sonnet 4.6",
          "contextWindow": 200000, "hasAuth": true,
          "thinkingMode": "adaptive", "thinkingEfforts": ["low","medium","high"] }
        """.data(using: .utf8)!
        let model = try JSONDecoder().decode(RemoteModelEntry.self, from: json)
        let s = ThinkingControlState.resolve(thinkingMode: model.thinkingMode, thinkingEfforts: model.thinkingEfforts)
        XCTAssertEqual(s.triggerLabel(for: "adaptive"), "Adaptive")
        XCTAssertTrue(s.enabled)
    }

    /// The regression assertion. A model that declares no efforts must still
    /// produce a control the view can render — the pre-fix code answered this
    /// question with a Bool that removed the view entirely.
    func testNoThinkingModelStillYieldsARenderableDisabledControl() throws {
        let json = """
        { "id": "gpt-4.1", "providerId": "openai", "label": "GPT-4.1",
          "contextWindow": 1000000, "hasAuth": true }
        """.data(using: .utf8)!
        let model = try JSONDecoder().decode(RemoteModelEntry.self, from: json)
        let s = ThinkingControlState.resolve(thinkingMode: model.thinkingMode, thinkingEfforts: model.thinkingEfforts)
        XCTAssertFalse(s.enabled, "no declared efforts ⇒ disabled")
        XCTAssertFalse(s.levels.isEmpty, "disabled must still be renderable, not hidden")
        XCTAssertEqual(s.triggerLabel(for: "off"), "Off")
    }

    /// The same guarantee asserted at the VIEW boundary. `ConversationStatusBar`
    /// used to answer "should the thinking control exist?" with a Bool
    /// (`showThinkingControl`) that gated an `if` around the whole menu; there
    /// is no longer any such property, and the bar instead resolves a state
    /// that always carries a row to draw. A regression that reintroduced the
    /// hide would have to make `levels` empty here.
    @MainActor
    func testStatusBarResolvesRenderableDisabledControlForNoThinkingModel() {
        let bar = ConversationStatusBar(
            modelOverride: "gpt-4.1",
            preferredModel: "gpt-4.1",
            contextPercent: nil,
            contextTokens: nil,
            engineContextWindow: nil,
            isRunning: false,
            permissionMode: .auto,
            availableModels: [
                RemoteModelEntry(
                    id: "gpt-4.1",
                    providerId: "openai",
                    label: "GPT-4.1",
                    contextWindow: 1_000_000,
                    hasAuth: true
                ),
            ],
            attachmentCount: 0,
            onSelectModel: { _ in },
            onToggleMode: {},
            onTapAttachments: {}
        )
        XCTAssertFalse(bar.thinkingState.enabled, "no declared efforts ⇒ disabled")
        XCTAssertFalse(bar.thinkingState.levels.isEmpty, "the control must still render")
        XCTAssertEqual(bar.thinkingState.offLabel, "Off")
    }

    /// And at the view boundary for an adaptive model: the trigger must read
    /// "Adaptive", which the pre-fix `thinkingLabel` switch could never produce.
    @MainActor
    func testStatusBarResolvesAdaptiveLabelForAdaptiveModel() {
        let bar = ConversationStatusBar(
            modelOverride: "claude-sonnet-4-6",
            preferredModel: "claude-sonnet-4-6",
            contextPercent: nil,
            contextTokens: nil,
            engineContextWindow: nil,
            isRunning: false,
            permissionMode: .auto,
            availableModels: [
                RemoteModelEntry(
                    id: "claude-sonnet-4-6",
                    providerId: "anthropic",
                    label: "Sonnet 4.6",
                    contextWindow: 200_000,
                    hasAuth: true,
                    thinkingMode: "adaptive",
                    thinkingEfforts: ["low", "medium", "high"]
                ),
            ],
            attachmentCount: 0,
            onSelectModel: { _ in },
            onToggleMode: {},
            onTapAttachments: {}
        )
        XCTAssertTrue(bar.thinkingState.enabled)
        XCTAssertEqual(bar.thinkingState.triggerLabel(for: "adaptive"), "Adaptive")
    }
}

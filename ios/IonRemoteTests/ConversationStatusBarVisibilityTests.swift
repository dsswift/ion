import XCTest
@testable import IonRemote

/// Pins the "always render, degrade gracefully" contract for the conversation
/// status bar's engine inputs (ConversationStatusBar.resolveEngineInputs).
///
/// The status bar must render for engine tabs the same way it does for plain
/// conversations — even when the engine instance has no StatusFields yet. The
/// resolver returns safe fallbacks so the core controls (model picker,
/// permission toggle, attachments) stay visible and only the status-dependent
/// chrome (status dot, context %, extension name) self-hides.
///
/// This is the testable seam the Phase 6 merged view consumes to render the bar
/// unconditionally, replacing the old `statusFields != nil` gate that hid the
/// whole bar for fresh engine tabs.
final class ConversationStatusBarVisibilityTests: XCTestCase {

    private func makeFields(
        state: String,
        model: String,
        contextPercent: Double,
        contextWindow: Int,
        extensionName: String?
    ) -> StatusFields {
        StatusFields(
            label: "",
            state: state,
            sessionId: nil,
            team: nil,
            model: model,
            contextPercent: contextPercent,
            contextWindow: contextWindow,
            runCostUsd: nil,
            conversationCostUsd: nil,
            permissionDenials: nil,
            extensionName: extensionName,
            backgroundAgents: nil,
            numTurns: nil,
            conversationTurns: nil
        )
    }

    func testNilFieldsYieldUsableFallbackInputs() {
        let inputs = ConversationStatusBar.resolveEngineInputs(
            fields: nil,
            fallbackPreferredModel: "claude-sonnet-4-6"
        )
        // Model falls back to the global preferred model so the picker still
        // shows a sensible label.
        XCTAssertEqual(inputs.preferredModel, "claude-sonnet-4-6")
        // Status-dependent chrome self-hides (nil), it does not gate the bar.
        XCTAssertNil(inputs.contextPercent)
        XCTAssertNil(inputs.engineContextWindow)
        XCTAssertNil(inputs.extensionName)
    }

    func testPopulatedFieldsArePassedThrough() {
        let fields = makeFields(
            state: "running",
            model: "claude-opus-4-7",
            contextPercent: 42.0,
            contextWindow: 200_000,
            extensionName: "Ion Dev"
        )
        let inputs = ConversationStatusBar.resolveEngineInputs(
            fields: fields,
            fallbackPreferredModel: "claude-sonnet-4-6"
        )
        XCTAssertEqual(inputs.preferredModel, "claude-opus-4-7")
        XCTAssertEqual(inputs.contextPercent, 42.0)
        XCTAssertEqual(inputs.engineContextWindow, 200_000)
        XCTAssertEqual(inputs.extensionName, "Ion Dev")
    }

    func testZeroContextWindowResolvesToNil() {
        // A 0 (or absent) context window must resolve to nil so the bar's
        // percent fallback uses the picker model's nominal window instead of
        // dividing by zero.
        let fields = makeFields(
            state: "idle",
            model: "claude-sonnet-4-6",
            contextPercent: 0,
            contextWindow: 0,
            extensionName: nil
        )
        let inputs = ConversationStatusBar.resolveEngineInputs(
            fields: fields,
            fallbackPreferredModel: "fallback"
        )
        XCTAssertNil(inputs.engineContextWindow)
        // Model still comes from the fields (non-empty), not the fallback.
        XCTAssertEqual(inputs.preferredModel, "claude-sonnet-4-6")
    }
}

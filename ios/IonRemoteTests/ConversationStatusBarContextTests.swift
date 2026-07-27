import XCTest
@testable import IonRemote

/// Tests for `RemoteTabState.contextWindow` decoding and the shipped
/// `ConversationStatusBar.resolveContextPercent` math.
///
/// These call the real resolver rather than re-implementing it. The previous
/// version of this file carried a local `resolvePercent` copy behind a "kept
/// in lockstep with the view" comment, and four of its six assertions
/// exercised a branch the production call site could never reach — the only
/// `ConversationStatusBar(...)` construction passed `contextTokens: nil`
/// hardcoded, so the token path was dead code on iOS.
final class ConversationStatusBarContextTests: XCTestCase {
    private let decoder = JSONDecoder()

    // MARK: - Decode

    /// Round-trip the optional `contextWindow` field. Absent decodes to nil
    /// (cold-start tab); present decodes to its Int value.
    func testRemoteTabStateDecodesContextWindow_Present() throws {
        let json = """
        {"id":"t1","title":"T","status":"idle","workingDirectory":"/","permissionMode":"auto","permissionQueue":[],"lastMessage":null,"contextTokens":497742,"contextWindow":1000000}
        """.data(using: .utf8)!
        let tab = try decoder.decode(RemoteTabState.self, from: json)
        XCTAssertEqual(tab.contextWindow, 1_000_000)
        XCTAssertEqual(tab.contextTokens, 497742)
    }

    func testRemoteTabStateDecodesContextWindow_Absent() throws {
        // No contextWindow key — must decode to nil and not crash. This is
        // the cold-start state where the engine has not yet reported.
        let json = """
        {"id":"t2","title":"T","status":"idle","workingDirectory":"/","permissionMode":"auto","permissionQueue":[],"lastMessage":null,"contextTokens":null}
        """.data(using: .utf8)!
        let tab = try decoder.decode(RemoteTabState.self, from: json)
        XCTAssertNil(tab.contextWindow)
    }

    // MARK: - Percent math (the shipped resolver)

    func testTokensOverSelectedWindow() {
        // The reported bug: an idle conversation holding ~224k tokens showed
        // 0%. The engine now publishes the absolute occupancy and the client
        // divides it by the selected model's window.
        let pct = ConversationStatusBar.resolveContextPercent(
            contextPercent: nil,
            contextTokens: 223_791,
            selectedModelWindow: 1_000_000,
        )
        XCTAssertNotNil(pct)
        XCTAssertEqual(pct!, 22.4, accuracy: 0.1)
    }

    func testModelSwitchRecomputes() {
        // No engine command can change an idle session's model, so the
        // picker-driven recompute must be pure client-side division.
        let onOpus = ConversationStatusBar.resolveContextPercent(
            contextPercent: nil, contextTokens: 220_000, selectedModelWindow: 1_000_000)
        let onSonnet = ConversationStatusBar.resolveContextPercent(
            contextPercent: nil, contextTokens: 220_000, selectedModelWindow: 200_000)
        XCTAssertEqual(onOpus!, 22.0, accuracy: 0.01)
        XCTAssertEqual(onSonnet!, 110.0, accuracy: 0.01)
    }

    func testUncappedOverBudget() {
        // 220k on a 100k model is 220%, not 100%. Over-budget is real
        // information and must not be clamped away at the data layer.
        let pct = ConversationStatusBar.resolveContextPercent(
            contextPercent: nil, contextTokens: 220_000, selectedModelWindow: 100_000)
        XCTAssertEqual(pct!, 220.0, accuracy: 0.01)
    }

    func testTokensWinOverEnginePercent() {
        // The engine's percent is anchored to whatever window IT measured
        // against, so it cannot react to the picker. Tokens win when present.
        let pct = ConversationStatusBar.resolveContextPercent(
            contextPercent: 42, contextTokens: 220_000, selectedModelWindow: 200_000)
        XCTAssertEqual(pct!, 110.0, accuracy: 0.01)
    }

    func testFallsBackToEnginePercentWithoutTokens() {
        // An older engine, or a backend that emits no usage events.
        let pct = ConversationStatusBar.resolveContextPercent(
            contextPercent: 42, contextTokens: nil, selectedModelWindow: 200_000)
        XCTAssertEqual(pct!, 42.0, accuracy: 0.01)
    }

    func testNilWhenNoDataAtAll() {
        XCTAssertNil(ConversationStatusBar.resolveContextPercent(
            contextPercent: nil, contextTokens: nil, selectedModelWindow: 200_000))
    }

    func testNilWindowFallsBackToEnginePercent() {
        // Picker model absent from the catalog and no engine window: the
        // token path cannot resolve, so the engine's percent is all we have.
        let pct = ConversationStatusBar.resolveContextPercent(
            contextPercent: 42, contextTokens: 220_000, selectedModelWindow: nil)
        XCTAssertEqual(pct!, 42.0, accuracy: 0.01)
    }

    // MARK: - Denominator resolution

    func testWindowPrefersSelectedModelOverEngineWindow() {
        let models = [
            RemoteModelEntry(id: "claude-sonnet-4-6", providerId: "anthropic", label: "Sonnet 4.6",
                             contextWindow: 200_000, hasAuth: true),
        ]
        let w = ConversationStatusBar.windowForModel(
            "claude-sonnet-4-6", availableModels: models, engineContextWindow: 1_000_000)
        XCTAssertEqual(w, 200_000)
    }

    func testWindowFallsBackToEngineWhenModelUnknown() {
        let w = ConversationStatusBar.windowForModel(
            "some-unlisted-model", availableModels: [], engineContextWindow: 1_000_000)
        XCTAssertEqual(w, 1_000_000)
    }

    func testWindowNilWhenNeitherAvailable() {
        XCTAssertNil(ConversationStatusBar.windowForModel(
            "some-unlisted-model", availableModels: [], engineContextWindow: nil))
    }
}

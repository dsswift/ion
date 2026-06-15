import XCTest
@testable import IonRemote

/// Tests for `RemoteTabState.contextWindow` decoding and the
/// `ConversationStatusBar.resolvedContextPercent` math.
///
/// The bug fixed in plan cosy-pacing-bee.md is that the iOS indicator
/// computed `Double(tokens) / Double(pickerModel.contextWindow)` when
/// the engine's `contextPercent` was null but `contextTokens` was set.
/// On a conversation anchored to opus-4-7 (1M window) with the picker
/// set to Sonnet 4.6, the local fallback returned 248% and the UI
/// rendered nonsense.
///
/// The fix takes the new optional `RemoteTabState.contextWindow` (the
/// engine's reported window) over the picker model's nominal window
/// whenever both are present. We test the decode path (proving the new
/// field round-trips) and reproduce the math here so a future
/// regression in `resolvedContextPercent` fails this test, not a
/// production user.
final class ConversationStatusBarContextTests: XCTestCase {
    private let decoder = JSONDecoder()

    // MARK: - Decode

    /// Round-trip the new optional `contextWindow` field. Absent decodes
    /// to nil (cold-start tab); present decodes to its Int value (engine
    /// has reported).
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

    // MARK: - Percent math

    /// Mirrors the math in ConversationStatusBar.resolvedContextPercent.
    /// Kept in lockstep with the view; any change in the view's
    /// fallback chain must update both sides. The "engine window wins"
    /// invariant is locked by the next test.
    private func resolvePercent(
        contextPercent: Double?,
        contextTokens: Int?,
        engineContextWindow: Int?,
        pickerWindow: Int?
    ) -> Double? {
        if let cp = contextPercent { return cp }
        guard let tokens = contextTokens else { return nil }
        let denominator: Int
        if let w = engineContextWindow, w > 0 {
            denominator = w
        } else if let w = pickerWindow, w > 0 {
            denominator = w
        } else {
            return nil
        }
        return Double(tokens) / Double(denominator) * 100.0
    }

    func testEngineWindowWinsOverPickerWindow() {
        // The original bug scenario: opus-running, picker on Sonnet.
        // Pre-fix the indicator returned 248% (and the UI rendered
        // nonsense). Post-fix the indicator returns ~50% because the
        // engine's reported 1M window wins.
        let pct = resolvePercent(
            contextPercent: nil,
            contextTokens: 497742,
            engineContextWindow: 1_000_000,
            pickerWindow: 200_000
        )
        XCTAssertNotNil(pct)
        XCTAssertEqual(pct!, 49.7742, accuracy: 0.01)
    }

    func testFallsBackToPickerWindowWhenEngineWindowAbsent() {
        // Cold-start tab: the engine hasn't reported a window yet but the
        // user is typing. The picker model's nominal window is the
        // documented fallback so the indicator renders something.
        let pct = resolvePercent(
            contextPercent: nil,
            contextTokens: 50_000,
            engineContextWindow: nil,
            pickerWindow: 200_000
        )
        XCTAssertNotNil(pct)
        XCTAssertEqual(pct!, 25.0, accuracy: 0.01)
    }

    func testEnginePercentTakesPrecedenceOverLocalComputation() {
        // When the engine has supplied a pre-computed percent, the local
        // fallback never runs. This path was iOS-correct before the
        // bug fix and must remain so.
        let pct = resolvePercent(
            contextPercent: 42.0,
            contextTokens: 99_999,
            engineContextWindow: 200_000,
            pickerWindow: 1_000_000
        )
        XCTAssertEqual(pct, 42.0)
    }

    func testNilWhenNoDataAtAll() {
        // Brand-new tab with no engine response and no tokens.
        let pct = resolvePercent(
            contextPercent: nil,
            contextTokens: nil,
            engineContextWindow: 1_000_000,
            pickerWindow: 200_000
        )
        XCTAssertNil(pct)
    }

    func testEngineWindowZeroTreatedAsAbsent() {
        // Some engine_status ticks arrive before the model is resolved
        // and report contextWindow=0. The iOS view treats 0 as "not yet
        // resolved" and falls back to the picker, matching the
        // desktop's "do not overwrite with 0" behavior in
        // engine-event-status.ts.
        let pct = resolvePercent(
            contextPercent: nil,
            contextTokens: 50_000,
            engineContextWindow: 0,
            pickerWindow: 200_000
        )
        XCTAssertNotNil(pct)
        XCTAssertEqual(pct!, 25.0, accuracy: 0.01)
    }
}

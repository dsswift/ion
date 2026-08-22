import XCTest
@testable import IonRemote

// MARK: - ContextOccupancyTests
//
// The engine publishes THREE token quantities on engine_context_breakdown and
// only ONE of them is occupancy. Confusing them is the defect these tests pin:
//
//   occupancyTokens  — the engine's authoritative "how full is the context".
//                      Same figure StatusFields.contextTokens carries, same
//                      input the proactive-compaction gate measures.
//   totalTokens      — the ITEMIZED per-category sum. Attribution only; it
//                      OVER-reports, counting content the provider did not bill
//                      for this turn.
//   apiReportedTotal — the raw provider input_tokens for the last turn, with
//                      nothing added for messages appended since, so it
//                      UNDER-reports mid-turn.
//
// iOS previously read `totalTokens` as occupancy, so a conversation the provider
// billed at 255,897 tokens against a 1M window rendered at ~103% instead of
// ~26%. The desktop was fixed first; these tests are the iOS half, and the
// parity assertion (a field that reaches one client must not be silently ignored
// on the other) that would have caught the gap.
//
// Split from ContextBreakdownDecodeTests.swift to keep both files under the
// 600-line Swift cap.
//
// Run with:
//   cd ios && xcodebuild test -project IonRemote.xcodeproj -scheme IonRemote \
//     -destination 'platform=iOS Simulator,name=iPhone 15' \
//     -only-testing IonRemoteTests/ContextOccupancyTests

final class ContextOccupancyTests: XCTestCase {

    // MARK: - 1a. occupancyTokens decode + occupancy selection
    //
    // The engine publishes THREE token quantities on a breakdown and only one is
    // occupancy. iOS previously read `totalTokens` — the itemized per-category
    // estimate — as occupancy, which rendered a conversation occupying 26% of a
    // 1M window as ~103%. These pin both halves of the fix: the field decodes,
    // and the resolver picks it over the itemized sum.

    func test_desktopContextBreakdown_decodesOccupancyTokens() throws {
        // Values from the reported conversation: the provider billed 255,897
        // input tokens while the itemized sum came to 1,034,443.
        let json = """
        {
            "type": "desktop_context_breakdown",
            "tabId": "tab-occupancy",
            "contextBreakdown": {
                "categories": [
                    { "name": "Conversation", "kind": "conversation", "tokens": 1000000, "tier": "local" }
                ],
                "contextWindow": 1000000,
                "totalTokens": 1034443,
                "apiReportedTotal": 255897,
                "occupancyTokens": 255897,
                "model": "claude-opus-4-8"
            }
        }
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)
        guard case .desktopContextBreakdown(_, _, let payload) = event else {
            XCTFail("Expected .desktopContextBreakdown"); return
        }
        XCTAssertEqual(payload.occupancyTokens, 255_897)
        // It must stay distinct from the itemized sum on the same payload.
        XCTAssertNotEqual(payload.occupancyTokens, payload.totalTokens)
    }

    func test_desktopContextBreakdown_omittedOccupancyDecodesNil() throws {
        // The engine omits the field (omitempty) when it has no occupancy figure
        // — a fresh conversation with no provider response yet. Swift must see
        // nil so the resolver's fallback chain engages.
        let json = """
        {
            "type": "desktop_context_breakdown",
            "tabId": "tab-no-occupancy",
            "contextBreakdown": {
                "categories": [],
                "contextWindow": 200000,
                "totalTokens": 4200,
                "model": "claude-opus-4"
            }
        }
        """.data(using: .utf8)!

        let event = try JSONDecoder().decode(RemoteEvent.self, from: json)
        guard case .desktopContextBreakdown(_, _, let payload) = event else {
            XCTFail("Expected .desktopContextBreakdown"); return
        }
        XCTAssertNil(payload.occupancyTokens)
    }

    /// Red on revert: restore the `contextBreakdown?.totalTokens` first branch in
    /// StatusDrawerView.contextTokens (or return breakdownTotal from the
    /// resolver) and this returns 1,034,443 instead of 255,897.
    func test_resolveContextTokens_prefersOccupancyOverItemizedTotal() {
        let got = ConversationStatusBar.resolveContextTokens(
            breakdownOccupancy: 255_897,
            breakdownTotal: 1_034_443,
            fieldsTokens: nil,
            instanceTokens: nil,
        )
        XCTAssertEqual(got, 255_897)
    }

    /// The itemized sum is never occupancy, even when it is the ONLY figure
    /// present. This is the parity assertion whose absence let the defect ship:
    /// a field that reaches one client and is silently ignored on the other.
    func test_resolveContextTokens_neverReturnsItemizedTotal() {
        let got = ConversationStatusBar.resolveContextTokens(
            breakdownOccupancy: nil,
            breakdownTotal: 1_034_443,
            fieldsTokens: nil,
            instanceTokens: nil,
        )
        XCTAssertNil(got, "totalTokens must never be used as occupancy")
    }

    func test_resolveContextTokens_fallsBackToStatusFields() {
        // No occupancy on the breakdown: fall through to the status path, which
        // carries the same quantity from the engine's streaming events.
        let got = ConversationStatusBar.resolveContextTokens(
            breakdownOccupancy: nil,
            breakdownTotal: 1_034_443,
            fieldsTokens: 227_099,
            instanceTokens: 99,
        )
        XCTAssertEqual(got, 227_099)
    }

    func test_resolveContextTokens_fallsBackToInstanceWhenFieldsAbsent() {
        let got = ConversationStatusBar.resolveContextTokens(
            breakdownOccupancy: nil,
            breakdownTotal: nil,
            fieldsTokens: nil,
            instanceTokens: 227_099,
        )
        XCTAssertEqual(got, 227_099)
    }

    func test_resolveContextTokens_treatsZeroAsAbsent() {
        // A zero occupancy is "no figure yet", not "an empty context" — the same
        // rule the desktop's resolveContextDisplay applies with `tokens <= 0`.
        let got = ConversationStatusBar.resolveContextTokens(
            breakdownOccupancy: 0,
            breakdownTotal: nil,
            fieldsTokens: 227_099,
            instanceTokens: nil,
        )
        XCTAssertEqual(got, 227_099)
    }

    // MARK: - Capacity admission

    func test_contextCapacityWarnsAtEightyPercentOfEffectiveLimit() {
        let models = [
            RemoteModelEntry(
                id: "test-model",
                providerId: "test",
                label: "Test",
                contextWindow: 200_000,
                maxOutputTokens: 20_000,
                hasAuth: true,
            ),
        ]
        // 200k raw minus 20k output and 13k compaction reserve leaves 167k.
        let capacity = ConversationStatusBar.resolveContextCapacity(
            occupancyTokens: 133_600,
            modelId: "test-model",
            availableModels: models,
            engineContextWindow: nil,
        )
        XCTAssertEqual(capacity?.effectiveLimit, 167_000)
        XCTAssertEqual(ConversationStatusBar.contextCapacityState(capacity), .warning)
    }

    /// The engine publishes its own usable-input limit on StatusFields as
    /// `contextEffectiveLimit`. iOS decoded a `contextLimit` key the engine
    /// never sends, so the value was always nil and every reading fell back to
    /// the client's reserve estimate.
    func test_statusFieldsDecodesTheEnginesEffectiveLimitKey() throws {
        let json = """
        {"label":"tab","state":"idle","model":"m","contextPercent":42,
         "contextWindow":200000,"contextTokens":84000,"contextEffectiveLimit":167000}
        """.data(using: .utf8)!
        let fields = try JSONDecoder().decode(StatusFields.self, from: json)
        XCTAssertEqual(fields.contextEffectiveLimit, 167_000)
    }

    /// The engine's reported limit is authoritative for the model the engine
    /// ran, so it wins over recomputing the reserves locally.
    func test_contextCapacityPrefersTheEngineReportedEffectiveLimit() {
        let capacity = ConversationStatusBar.resolveContextCapacity(
            occupancyTokens: 100_000,
            modelId: "unknown-to-this-client",
            availableModels: [],
            engineContextWindow: 200_000,
            engineEffectiveLimit: 150_000,
        )
        XCTAssertEqual(capacity?.effectiveLimit, 150_000)
    }

    /// Moving the picker to a model the engine has not run must recompute from
    /// THAT model, never from the stale engine figure — otherwise admission
    /// reports the previous model's budget.
    func test_selectedModelOverridesTheEngineReportedLimit() {
        let models = [
            RemoteModelEntry(
                id: "selected-model",
                providerId: "test",
                label: "Selected",
                contextWindow: 100_000,
                maxOutputTokens: 20_000,
                hasAuth: true,
            ),
        ]
        let capacity = ConversationStatusBar.resolveContextCapacity(
            occupancyTokens: 67_000,
            modelId: "selected-model",
            availableModels: models,
            engineContextWindow: 1_000_000,
            engineEffectiveLimit: 900_000,
        )
        // 100k raw minus 20k output and 13k compaction reserve leaves 67k.
        XCTAssertEqual(capacity?.effectiveLimit, 67_000)
        XCTAssertEqual(ConversationStatusBar.contextCapacityState(capacity), .full)
    }

    /// A model that publishes its own effective limit uses it directly rather
    /// than subtracting the reserves a second time.
    func test_publishedModelLimitIsUsedWithoutRecomputingReserves() {
        let models = [
            RemoteModelEntry(
                id: "selected-model",
                providerId: "test",
                label: "Selected",
                contextWindow: 200_000,
                maxOutputTokens: 20_000,
                effectiveContextLimit: 180_000,
                hasAuth: true,
            ),
        ]
        let capacity = ConversationStatusBar.resolveContextCapacity(
            occupancyTokens: 90_000,
            modelId: "selected-model",
            availableModels: models,
            engineContextWindow: nil,
        )
        XCTAssertEqual(capacity?.effectiveLimit, 180_000)
    }

    func test_contextCapacityBlocksOnlyAtEffectiveLimitAndAllowsRecoveryCommands() {
        let models = [
            RemoteModelEntry(
                id: "test-model",
                providerId: "test",
                label: "Test",
                contextWindow: 200_000,
                maxOutputTokens: 20_000,
                hasAuth: true,
            ),
        ]
        let capacity = ConversationStatusBar.resolveContextCapacity(
            occupancyTokens: 167_000,
            modelId: "test-model",
            availableModels: models,
            engineContextWindow: nil,
        )
        XCTAssertEqual(ConversationStatusBar.contextCapacityState(capacity), .full)
        XCTAssertTrue(ConversationStatusBar.contextCapacityBlocksPrompt(capacity, text: "ordinary prompt"))
        XCTAssertFalse(ConversationStatusBar.contextCapacityBlocksPrompt(capacity, text: " /compact now"))
        XCTAssertFalse(ConversationStatusBar.contextCapacityBlocksPrompt(capacity, text: "/clear"))
    }

    func test_contextCapacityUsesSelectedModelInsteadOfPriorEngineWindow() {
        let models = [
            RemoteModelEntry(
                id: "selected-model",
                providerId: "test",
                label: "Selected",
                contextWindow: 200_000,
                maxOutputTokens: 20_000,
                hasAuth: true,
            ),
        ]
        let capacity = ConversationStatusBar.resolveContextCapacity(
            occupancyTokens: 167_000,
            modelId: "selected-model",
            availableModels: models,
            engineContextWindow: 1_000_000,
        )
        XCTAssertEqual(capacity?.effectiveLimit, 167_000)
        XCTAssertEqual(ConversationStatusBar.contextCapacityState(capacity), .full)
    }

}

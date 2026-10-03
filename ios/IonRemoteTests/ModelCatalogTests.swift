import XCTest
@testable import IonRemote

/// Pins the bridge between a conversation's model id and the catalog's
/// entries. A provider-qualified id used to match nothing, which printed the
/// raw id in the composer and resolved the thinking control as unavailable.
final class ModelCatalogTests: XCTestCase {

    private let fable = RemoteModelEntry(id: "claude-fable-5-1", providerId: "anthropic", label: "Fable 5.1", contextWindow: 1_000_000, hasAuth: true)
    private let gpt = RemoteModelEntry(id: "gpt-5", providerId: "openai", label: "GPT-5", contextWindow: 400_000, hasAuth: true)

    func testExactIdMatches() {
        XCTAssertEqual(ModelCatalog.entry(for: "claude-fable-5-1", in: [fable, gpt])?.label, "Fable 5.1")
    }

    func testProviderQualifiedIdMatchesTheBareEntryUnderThatProvider() {
        XCTAssertEqual(ModelCatalog.entry(for: "anthropic/claude-fable-5-1", in: [fable, gpt])?.id, "claude-fable-5-1")
        XCTAssertEqual(ModelCatalog.displayLabel(for: "anthropic/claude-fable-5-1", in: [fable, gpt]), "Fable 5.1")
    }

    func testQualifiedIdPicksTheNamedProviderWhenTwoOfferTheModel() {
        let viaGateway = RemoteModelEntry(id: "claude-fable-5-1", providerId: "gateway", label: "Fable 5.1 (gateway)", contextWindow: 1_000_000, hasAuth: true)
        XCTAssertEqual(ModelCatalog.entry(for: "gateway/claude-fable-5-1", in: [fable, viaGateway])?.providerId, "gateway")
        XCTAssertNil(ModelCatalog.entry(for: "other/claude-fable-5-1", in: [fable, viaGateway]),
                     "two providers and neither named is ambiguous, not a guess")
    }

    func testUnknownModelShowsItsIdWithoutTheProviderPrefix() {
        XCTAssertNil(ModelCatalog.entry(for: "anthropic/some-new-model", in: [fable]))
        XCTAssertEqual(ModelCatalog.displayLabel(for: "anthropic/some-new-model", in: [fable]), "some-new-model")
        XCTAssertEqual(ModelCatalog.displayLabel(for: "plain-model", in: []), "plain-model")
        XCTAssertNil(ModelCatalog.entry(for: "", in: [fable]))
    }

    /// At the composer: the qualified id resolves the short label and the
    /// model's thinking levels.
    @MainActor
    func testStatusBarResolvesAQualifiedModel() {
        var thinking = fable
        thinking.thinkingEfforts = ["low", "high"]
        let bar = ConversationStatusBar(
            modelOverride: nil,
            preferredModel: "anthropic/claude-fable-5-1",
            contextPercent: nil,
            contextTokens: 100_000,
            engineContextWindow: nil,
            isRunning: false,
            permissionMode: .auto,
            availableModels: [thinking],
            onSelectModel: { _, _ in },
            onToggleMode: {},
        )
        XCTAssertTrue(bar.thinkingState.enabled, "the model's thinking levels must be found")
        XCTAssertEqual(bar.selectedModelWindow, 1_000_000)
    }
}

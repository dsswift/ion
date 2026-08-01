import XCTest
@testable import IonRemote

/// Pins the provider-grouped model picker's logic — every behavior the
/// previous flat `Menu` lacked, so a regression back to an ungrouped,
/// unfiltered list fails here rather than shipping.
///
/// Also pins the iOS half of the wire contract for the two fields the desktop
/// added for this surface (`providerLabel`, `isCustom`): both are optional, so
/// a snapshot from a desktop that predates them must still decode.
final class ModelPickerGroupingTests: XCTestCase {

    // MARK: - Fixtures

    private func model(
        _ id: String,
        provider: String,
        label: String,
        hasAuth: Bool = true,
        providerLabel: String? = nil,
        modelKind: String? = nil,
        isCustom: Bool? = nil,
    ) -> RemoteModelEntry {
        RemoteModelEntry(
            id: id,
            providerId: provider,
            label: label,
            contextWindow: 200_000,
            hasAuth: hasAuth,
            providerLabel: providerLabel,
            thinkingMode: nil,
            thinkingEfforts: nil,
            modelKind: modelKind,
            isCustom: isCustom,
        )
    }

    /// Two authed providers plus one unconfigured provider.
    private var mixedCatalog: [RemoteModelEntry] {
        [
            model("claude-opus-4-6", provider: "anthropic", label: "Opus 4.6", providerLabel: "Anthropic"),
            model("claude-sonnet-4-6", provider: "anthropic", label: "Sonnet 4.6", providerLabel: "Anthropic"),
            model("gpt-4.1", provider: "openai", label: "GPT-4.1", hasAuth: false, providerLabel: "OpenAI"),
            model("grok-3", provider: "xai", label: "Grok 3", providerLabel: "xAI"),
        ]
    }

    // MARK: - Auth filtering

    func testEmptyQueryShowsOnlyAuthenticatedProviders() {
        let groups = ModelPickerGrouping.groups(models: mixedCatalog, searchQuery: "")
        XCTAssertEqual(groups.map(\.id), ["anthropic", "xai"])
        XCTAssertTrue(groups.allSatisfy(\.hasAuth))
    }

    func testSearchRevealsUnauthenticatedProviderWithHasAuthFalse() throws {
        let groups = ModelPickerGrouping.groups(models: mixedCatalog, searchQuery: "gpt")
        XCTAssertEqual(groups.count, 1)
        let group = try XCTUnwrap(groups.first)
        XCTAssertEqual(group.id, "openai")
        XCTAssertFalse(group.hasAuth, "an unconfigured provider's group must report hasAuth == false so its rows render disabled")
        XCTAssertEqual(group.models.map(\.id), ["gpt-4.1"])
    }

    func testWhitespaceOnlyQueryIsTreatedAsNoSearch() {
        let groups = ModelPickerGrouping.groups(models: mixedCatalog, searchQuery: "   ")
        XCTAssertEqual(groups.map(\.id), ["anthropic", "xai"])
    }

    // MARK: - Ordering and grouping

    func testGroupOrderFollowsFirstAppearance() {
        let catalog = [
            model("grok-3", provider: "xai", label: "Grok 3"),
            model("claude-opus-4-6", provider: "anthropic", label: "Opus 4.6"),
            model("grok-2", provider: "xai", label: "Grok 2"),
        ]
        let groups = ModelPickerGrouping.groups(models: catalog, searchQuery: "")
        XCTAssertEqual(groups.map(\.id), ["xai", "anthropic"])
        // A provider seen again later joins its existing group rather than
        // opening a second section.
        XCTAssertEqual(groups.first?.models.map(\.id), ["grok-3", "grok-2"])
    }

    func testModelOrderWithinGroupIsPreserved() {
        let groups = ModelPickerGrouping.groups(models: mixedCatalog, searchQuery: "")
        XCTAssertEqual(groups.first?.models.map(\.id), ["claude-opus-4-6", "claude-sonnet-4-6"])
    }

    // MARK: - Provider label resolution

    func testProviderLabelPrefersDesktopResolvedLabel() {
        let entry = model("m", provider: "anthropic", label: "M", providerLabel: "Acme Gateway")
        XCTAssertEqual(ModelPickerGrouping.providerLabel(for: entry), "Acme Gateway")
    }

    func testProviderLabelFallsBackToCapitalizedIdWhenAbsent() {
        let entry = model("m", provider: "skunkworks", label: "M", providerLabel: nil)
        XCTAssertEqual(ModelPickerGrouping.providerLabel(for: entry), "Skunkworks")
    }

    func testProviderLabelFallsBackWhenEmpty() {
        let entry = model("m", provider: "ollama", label: "M", providerLabel: "")
        XCTAssertEqual(ModelPickerGrouping.providerLabel(for: entry), "Ollama")
    }

    func testCapitalizedFallbackLeavesInteriorCharactersUntouched() {
        // "xAI"-style ids must not be upper-cased wholesale, and a desktop that
        // sends the real label is what produces "xAI" — the fallback only ever
        // touches the first character.
        let entry = model("m", provider: "openRouter", label: "M", providerLabel: nil)
        XCTAssertEqual(ModelPickerGrouping.providerLabel(for: entry), "OpenRouter")
    }

    func testGroupLabelUsesResolvedProviderLabel() {
        let groups = ModelPickerGrouping.groups(models: mixedCatalog, searchQuery: "")
        XCTAssertEqual(groups.map(\.label), ["Anthropic", "xAI"])
    }

    // MARK: - Search matching

    func testSearchMatchesOnModelId() {
        XCTAssertTrue(ModelPickerGrouping.matches(
            model: model("claude-opus-4-6", provider: "anthropic", label: "Opus 4.6"),
            query: "opus-4"))
    }

    func testSearchMatchesOnDisplayLabel() {
        XCTAssertTrue(ModelPickerGrouping.matches(
            model: model("gpt-4.1", provider: "openai", label: "GPT-4.1"),
            query: "gpt-4.1"))
    }

    func testSearchIsCaseInsensitive() {
        let entry = model("claude-opus-4-6", provider: "anthropic", label: "Opus 4.6")
        XCTAssertTrue(ModelPickerGrouping.matches(model: entry, query: "OPUS"))
        XCTAssertTrue(ModelPickerGrouping.matches(model: entry, query: "CLAUDE"))
    }

    func testSearchWithNoMatchYieldsNoGroups() {
        XCTAssertTrue(ModelPickerGrouping.groups(models: mixedCatalog, searchQuery: "zzz").isEmpty)
    }

    // MARK: - Duplicate labels

    func testDuplicateLabelsFlaggedWithinOneGroup() {
        let catalog = [
            model("llama-3.3-70b", provider: "groq", label: "Llama 3.3 70B"),
            model("llama-3.3-70b-versatile", provider: "groq", label: "Llama 3.3 70B"),
            model("llama-3.1-8b", provider: "groq", label: "Llama 3.1 8B"),
        ]
        let group = ModelPickerGrouping.groups(models: catalog, searchQuery: "")[0]
        XCTAssertEqual(ModelPickerGrouping.duplicateLabels(in: group), ["Llama 3.3 70B"])
    }

    func testSameLabelUnderTwoProvidersIsNotADuplicate() {
        // The section header already disambiguates these, so neither row needs
        // its raw id appended.
        let catalog = [
            model("llama-3.3-70b", provider: "groq", label: "Llama 3.3 70B"),
            model("llama-3.3-70b", provider: "together", label: "Llama 3.3 70B"),
        ]
        let groups = ModelPickerGrouping.groups(models: catalog, searchQuery: "")
        XCTAssertEqual(groups.count, 2)
        for group in groups {
            XCTAssertTrue(ModelPickerGrouping.duplicateLabels(in: group).isEmpty)
        }
    }

    // MARK: - Chrome gates

    func testShowSearchBoundaryAtSix() {
        XCTAssertFalse(ModelPickerGrouping.showSearch(modelCount: 6))
        XCTAssertTrue(ModelPickerGrouping.showSearch(modelCount: 7))
    }

    func testOtherProvidersHintOnlyWhenSomethingIsHidden() {
        XCTAssertTrue(ModelPickerGrouping.showOtherProvidersHint(models: mixedCatalog))
        let allAuthed = mixedCatalog.filter(\.hasAuth)
        XCTAssertFalse(ModelPickerGrouping.showOtherProvidersHint(models: allAuthed))
    }

    func testOtherProvidersHintFalseWhenNothingIsConfigured() {
        // Nothing authed means the browse list is empty, not a subset — the
        // picker shows "No providers configured" instead of the search hint.
        let noneAuthed = [model("gpt-4.1", provider: "openai", label: "GPT-4.1", hasAuth: false)]
        XCTAssertFalse(ModelPickerGrouping.showOtherProvidersHint(models: noneAuthed))
    }

    // MARK: - Wire contract

    func testDecodesProviderLabelAndIsCustom() throws {
        let json = """
        {"id":"my-llama","providerId":"ollama","providerLabel":"Local Ollama","label":"My Llama",
         "contextWindow":32000,"hasAuth":true,"modelKind":"chat","isCustom":true}
        """.data(using: .utf8)!
        let entry = try JSONDecoder().decode(RemoteModelEntry.self, from: json)
        XCTAssertEqual(entry.providerLabel, "Local Ollama")
        XCTAssertEqual(entry.isCustom, true)
        XCTAssertEqual(ModelPickerGrouping.providerLabel(for: entry), "Local Ollama")
    }

    func testDecodesEntryFromDesktopPredatingTheNewFields() throws {
        // Back-compat: an older desktop omits both fields entirely. Decode must
        // succeed and the picker must fall back to the capitalized provider id.
        let json = """
        {"id":"claude-opus-4-6","providerId":"anthropic","label":"Opus 4.6",
         "contextWindow":1000000,"hasAuth":true}
        """.data(using: .utf8)!
        let entry = try JSONDecoder().decode(RemoteModelEntry.self, from: json)
        XCTAssertNil(entry.providerLabel)
        XCTAssertNil(entry.isCustom)
        XCTAssertEqual(ModelPickerGrouping.providerLabel(for: entry), "Anthropic")
    }
}

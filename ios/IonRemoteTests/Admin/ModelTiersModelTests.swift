import XCTest
@testable import IonRemote

/// The tiers screen lists built-in tiers first, keeps saved models the
/// engine no longer offers visible, applies the engine's snapshots without
/// re-reading, and edits only the first fallback.
@MainActor
final class ModelTiersModelTests: XCTestCase {

    private func make() async -> (ModelTiersModel, FakeActionCaller, ServerAdminEvents) {
        let caller = FakeActionCaller(scopes: ["admin"])
        caller.answer(.modelListTiers, with: .success(ModelsFixtures.json(ModelsFixtures.tiers)))
        caller.answer(.providerGetDefault, with: .success(.string("anthropic")))
        caller.answer(.modelList, with: .success(ModelsFixtures.json(ModelsFixtures.catalog)))
        for action in [PhoneAction.modelSetTier, .modelRemoveTier, .providerSetDefault] {
            caller.answer(action, with: .success(ModelsFixtures.ok))
        }
        let events = ServerAdminEvents()
        let model = ModelTiersModel(client: ServerAdminClient(serverLabel: "Studio Mac", caller: caller), serverId: "srv", events: events)
        await model.load()
        return (model, caller, events)
    }

    func testBuiltInTiersComeFirstConfiguredOrNot() async {
        let (model, _, _) = await make()
        XCTAssertEqual(model.orderedTiers.map(\.name), ["reasoning", "standard", "fast", "workbench-sync", "review"])
        XCTAssertEqual(model.tier(named: "reasoning")?.model, "")
        XCTAssertEqual(model.defaultProvider, "anthropic")
    }

    func testASavedModelTheEngineNoLongerListsStaysVisibleAsUnavailable() async {
        let (model, _, _) = await make()
        let groups = model.choices(configured: ["gone-model", "claude-sonnet-5"])
        XCTAssertEqual(groups.map(\.providerId), ["anthropic", "openai", "groq", "Unknown"])
        XCTAssertEqual(groups.last?.choices, [.init(value: "gone-model", label: "gone-model (unavailable)", unavailable: true)])
        XCTAssertEqual(groups.first?.label, "Anthropic")
    }

    func testTheEnginesSnapshotsApplyWithoutAnotherRead() async {
        let (model, caller, events) = await make()
        let following = Task { await model.follow() }
        await waitUntil("the follow reload") { caller.calls.filter { $0.action == "model.listTiers" }.count == 2 }

        events.publish(ServerAdminEvent(serverId: "srv", channel: ServerAdminEvent.modelTiersUpdated,
                                        payload: ModelsFixtures.json(#"{"modelTiers":[{"name":"fast","model":"llama-4","fallbacks":null}]}"#)))
        events.publish(ServerAdminEvent(serverId: "srv", channel: ServerAdminEvent.defaultProviderUpdated,
                                        payload: ModelsFixtures.json(#"{"defaultProvider":""}"#)))

        await waitUntil("the snapshots land") { await MainActor.run { model.tiers?.count == 1 && model.defaultProvider == "" } }
        XCTAssertEqual(model.tier(named: "fast")?.model, "llama-4")
        XCTAssertEqual(caller.calls.filter { $0.action == "model.listTiers" }.count, 2, "a snapshot is applied, not re-read")
        following.cancel()
    }

    func testTheFallbackEditKeepsTheRestOfTheChain() async throws {
        let (model, caller, _) = await make()
        let standard = try XCTUnwrap(model.tier(named: "standard"))
        await model.setFallback(standard, model: "llama-4")
        XCTAssertEqual(caller.calls.last?.args, [.object([
            "name": .string("standard"), "model": .string("claude-sonnet-5"),
            "fallbacks": .array([.string("llama-4"), .string("claude-haiku-4-5")]),
        ])])
        let updated = try XCTUnwrap(model.tier(named: "standard"))
        await model.setFallback(updated, model: "")
        XCTAssertEqual(model.tier(named: "standard")?.fallbacks, ["claude-haiku-4-5"])
    }

    func testANewTiersNameMayNotTakeABuiltInOrExistingName() async {
        let (model, _, _) = await make()
        XCTAssertEqual(model.nameProblem("Fast"), "Built-in tier names are reserved.")
        XCTAssertEqual(model.nameProblem("review"), "A tier with that name already exists.")
        XCTAssertNil(model.nameProblem("triage"))
    }

    func testARemovedTierLeavesTheListAndAFailedDefaultProviderSaveRevertsIt() async {
        let (model, caller, _) = await make()
        await model.remove("review")
        XCTAssertNil(model.tiers?.first { $0.name == "review" })

        caller.answer(.providerSetDefault, with: .success(ModelsFixtures.declined("engine unreachable")))
        await model.setDefaultProvider("openai")
        XCTAssertEqual(model.defaultProvider, "anthropic")
        XCTAssertEqual(model.error, "engine unreachable")
    }

    func testASavedDefaultProviderThatIsNotSignedInIsMarkedUnavailable() async {
        let (model, caller, _) = await make()
        caller.answer(.providerGetDefault, with: .success(.string("xai")))
        await model.load()
        XCTAssertEqual(model.defaultProviderChoices.map(\.label), ["Anthropic", "OpenAI", "xAI (unavailable)"])
    }
}

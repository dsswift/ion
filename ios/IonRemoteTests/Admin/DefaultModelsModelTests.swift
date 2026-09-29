import XCTest
@testable import IonRemote

/// Your default models on a server offer only that server's signed-in,
/// permitted models, save as Account settings, and put the old value back
/// when the save fails.
@MainActor
final class DefaultModelsModelTests: XCTestCase {

    private func make() async -> (DefaultModelsModel, FakeActionCaller) {
        let caller = FakeActionCaller(scopes: ["conversations:read"])
        caller.answer(.settingsLoad, with: .success(ModelsFixtures.json(ModelsFixtures.settings)))
        caller.answer(.modelList, with: .success(ModelsFixtures.json(ModelsFixtures.catalog)))
        caller.answer(.policyGetFull, with: .success(ModelsFixtures.json(#"{"blockedModels":["claude-haiku-4-5"]}"#)))
        caller.answer(.settingsSave, with: .success(ModelsFixtures.ok))
        let model = DefaultModelsModel(client: ServerAdminClient(serverLabel: "Studio Mac", caller: caller), serverId: "srv")
        await model.load()
        return (model, caller)
    }

    func testThePickerOffersSignedInPermittedModelsOnly() async {
        let (model, _) = await make()
        XCTAssertEqual(model.pickerModels.map(\.id), ["claude-sonnet-5", "openai/gpt-5"])
        XCTAssertEqual(model.pickerModels.first?.providerLabel, "Anthropic")
        XCTAssertEqual(model.preferredModel, "claude-sonnet-5")
        XCTAssertEqual(model.engineDefaultModel, "")
    }

    func testAModelThisServerDoesNotOfferIsNamedAsMissing() async {
        let (model, _) = await make()
        XCTAssertEqual(model.label(for: "claude-sonnet-5"), "Claude Sonnet 5")
        XCTAssertEqual(model.label(for: "gpt-4o"), "gpt-4o (not on this server)")
    }

    func testADefaultSavesAsAnAccountSetting() async {
        let (model, caller) = await make()
        await model.setEngineDefaultModel("openai/gpt-5")
        XCTAssertEqual(caller.calls.last, .init(action: "settings.save", args: [.object(["engineDefaultModel": .string("openai/gpt-5")])]))
        await model.setEngineDefaultModel("")
        XCTAssertEqual(caller.calls.last?.args, [.object(["engineDefaultModel": .string("")])], "empty follows the conversation model")
    }

    func testAFailedSavePutsTheOldDefaultBack() async {
        let (model, caller) = await make()
        caller.answer(.settingsSave, with: .failure(StudioActionFailure.failed(code: "settings_save_failed", message: "disk full")))
        await model.setPreferredModel("openai/gpt-5")
        XCTAssertEqual(model.preferredModel, "claude-sonnet-5")
        XCTAssertEqual(model.error, "disk full")
    }
}

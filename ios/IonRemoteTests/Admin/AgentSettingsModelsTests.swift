import XCTest
@testable import IonRemote

/// Engine profiles and workflow prompts load from the server's settings and
/// save their whole Environment key; a refused save leaves what was there.
@MainActor
final class AgentSettingsModelsTests: XCTestCase {

    private func caller() -> FakeActionCaller {
        let caller = FakeActionCaller(scopes: ["admin"])
        caller.answer(.settingsLoad, with: .success(ModelsFixtures.json(ModelsFixtures.settings)))
        caller.answer(.aiAssistWorkflows, with: .success(ModelsFixtures.json(ModelsFixtures.workflows)))
        caller.answer(.settingsSave, with: .success(ModelsFixtures.ok))
        return caller
    }

    func testAnAddedProfileSavesTheWholeList() async throws {
        let fake = caller()
        let model = EngineProfilesModel(client: ServerAdminClient(serverLabel: "Studio Mac", caller: fake), serverId: "srv")
        await model.load()
        XCTAssertEqual(model.profiles?.map(\.name), ["cos"])

        let added = EngineProfile(id: "e5f6a7b8", name: "review", extensions: ["/srv/ext/review.ts"], defaultMode: "auto")
        let saved = await model.save(added)

        XCTAssertTrue(saved)
        XCTAssertEqual(model.profiles?.map(\.id), ["a1b2c3d4", "e5f6a7b8"])
        let sent = try XCTUnwrap(fake.calls.last?.args.first?["engineProfiles"]?.arrayValue)
        XCTAssertEqual(sent.compactMap { $0["id"]?.stringValue }, ["a1b2c3d4", "e5f6a7b8"])
    }

    func testARefusedDeleteKeepsTheProfile() async {
        let fake = caller()
        let model = EngineProfilesModel(client: ServerAdminClient(serverLabel: "Studio Mac", caller: fake), serverId: "srv")
        await model.load()
        fake.answer(.settingsSave, with: .failure(StudioActionFailure.refused(code: "settings_locked", message: "changing engineProfiles requires the admin scope on this server")))

        let removed = await model.remove(id: "a1b2c3d4")

        XCTAssertFalse(removed)
        XCTAssertEqual(model.profiles?.map(\.id), ["a1b2c3d4"])
        XCTAssertEqual(model.error, "changing engineProfiles requires the admin scope on this server")
    }

    func testAProfileWithNoSavedListLoadsEmpty() async {
        let fake = FakeActionCaller(scopes: ["admin"])
        fake.answer(.settingsLoad, with: .success(ModelsFixtures.json("{}")))
        let model = EngineProfilesModel(client: ServerAdminClient(serverLabel: "Studio Mac", caller: fake), serverId: "srv")
        await model.load()
        XCTAssertEqual(model.profiles, [])
    }

    func testWorkflowRowsSayWhetherTheirPromptIsCustomized() async throws {
        let model = AIWorkflowPromptsModel(client: ServerAdminClient(serverLabel: "Studio Mac", caller: caller()), serverId: "srv")
        await model.load()
        XCTAssertFalse(model.isCustomized("rebase-resolution"))
        XCTAssertTrue(model.isCustomized("merge-resolution"))
        XCTAssertEqual(model.effectivePrompt(try XCTUnwrap(model.workflow(id: "merge-resolution"))), "Merge {{directory}} carefully.")
    }

    func testSavingTheBuiltInPromptDropsTheOverride() async throws {
        let fake = caller()
        let model = AIWorkflowPromptsModel(client: ServerAdminClient(serverLabel: "Studio Mac", caller: fake), serverId: "srv")
        await model.load()
        let merge = try XCTUnwrap(model.workflow(id: "merge-resolution"))

        await model.save(merge, prompt: merge.defaultTemplate)

        XCTAssertFalse(model.isCustomized("merge-resolution"))
        XCTAssertEqual(fake.calls.last?.args, [.object(["aiAssistPromptOverrides": .object([:])])])
    }

    func testAPromptWithAnUnknownPlaceholderIsNotSent() async throws {
        let fake = caller()
        let model = AIWorkflowPromptsModel(client: ServerAdminClient(serverLabel: "Studio Mac", caller: fake), serverId: "srv")
        await model.load()
        let rebase = try XCTUnwrap(model.workflow(id: "rebase-resolution"))

        let saved = await model.save(rebase, prompt: "Rebase {{directory}} onto {{branch}}.")

        XCTAssertFalse(saved)
        XCTAssertEqual(model.error, "Unknown placeholder: {{branch}}")
        XCTAssertFalse(fake.calls.contains { $0.action == "settings.save" })
    }

    func testAResetKeepsTheOtherOverrides() async throws {
        let fake = caller()
        let model = AIWorkflowPromptsModel(client: ServerAdminClient(serverLabel: "Studio Mac", caller: fake), serverId: "srv")
        await model.load()
        let rebase = try XCTUnwrap(model.workflow(id: "rebase-resolution"))
        await model.save(rebase, prompt: "Rebase {{directory}} now.")

        await model.reset(rebase)

        XCTAssertEqual(fake.calls.last?.args, [.object(["aiAssistPromptOverrides": .object(["merge-resolution": .string("Merge {{directory}} carefully.")])])])
    }
}

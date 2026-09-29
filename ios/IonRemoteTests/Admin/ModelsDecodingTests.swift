import XCTest
@testable import IonRemote

/// The provider, model, tier, sign-in, and workflow results decode from the
/// shapes the server really sends, including its nulls and newer values.
final class ModelsDecodingTests: XCTestCase {

    func testTheCatalogDecodesProvidersModelsAndTheirCli() throws {
        let catalog = try ModelsFixtures.json(ModelsFixtures.catalog).decoded(as: ServerModelCatalog.self)

        XCTAssertEqual(catalog.models.map(\.id), ["claude-sonnet-5", "claude-haiku-4-5", "openai/gpt-5", "llama-4"])
        XCTAssertEqual(catalog.models[0].label, "Claude Sonnet 5")
        XCTAssertEqual(catalog.models[2].label, "gpt-5", "the routing prefix is not part of the name")
        let anthropic = try XCTUnwrap(catalog.providers.first { $0.id == "anthropic" })
        XCTAssertEqual(anthropic.cli?.authenticated, true)
        XCTAssertEqual(anthropic.loginFlow, .browserCode)
        XCTAssertEqual(anthropic.statusLabel, "Claude Max · user@example.com")
    }

    func testAFlowFromANewerEngineReadsAsUnknownNotAsABrokenListing() throws {
        let catalog = try ModelsFixtures.json(ModelsFixtures.catalog).decoded(as: ServerModelCatalog.self)
        XCTAssertNil(catalog.providers.first { $0.id == "google" }?.loginFlow)
    }

    func testAnEmptyListingOmitsItsLists() throws {
        let catalog = try ModelsFixtures.json("{}").decoded(as: ServerModelCatalog.self)
        XCTAssertEqual(catalog, .empty)
    }

    func testTiersDecodeANullFallbackListAsEmpty() throws {
        let tiers = try ModelsFixtures.json(ModelsFixtures.tiers).decoded(as: [ModelTier].self)
        XCTAssertEqual(tiers[0], ModelTier(name: "fast", model: "claude-haiku-4-5", fallbacks: []))
        XCTAssertEqual(tiers[1].fallbacks, ["openai/gpt-5", "claude-haiku-4-5"])
    }

    func testASignInStageDecodesAndAnUnknownStageIsKeptRaw() throws {
        let update = try ModelsFixtures.json(#"{"provider":"openai","backend":"codex","stage":"await_device_code","userCode":"ABCD-1234","verificationUrl":"https://auth.example.org/device"}"#)
            .decoded(as: ProviderLoginUpdate.self)
        XCTAssertEqual(update.knownStage, .awaitDeviceCode)
        XCTAssertEqual(update.userCode, "ABCD-1234")
        let unknown = try ModelsFixtures.json(#"{"provider":"openai","backend":"codex","stage":"await_hardware_key"}"#).decoded(as: ProviderLoginUpdate.self)
        XCTAssertNil(unknown.knownStage)
        XCTAssertEqual(unknown.stage, "await_hardware_key")
    }

    func testTheGitHubDeviceCodeDecodesFromTheServersAnswer() throws {
        let code = try ModelsFixtures.json(#"{"ok":true,"deviceCode":"dev-1","userCode":"WXYZ-9876","verificationUri":"https://github.com/login/device","interval":5,"expiresIn":900}"#)
            .decoded(as: GitHubDeviceCode.self)
        XCTAssertEqual(code, GitHubDeviceCode(userCode: "WXYZ-9876", verificationUri: "https://github.com/login/device", deviceCode: "dev-1", interval: 5, expiresIn: 900))
    }

    func testThePolicyNarrowsProvidersAndModelsAsTheEngineDoes() throws {
        let policy = try ModelsFixtures.json(#"{"allowedProviders":["anthropic"],"allowedModels":["claude-sonnet-5","claude-haiku-4-5"],"blockedModels":["claude-haiku-4-5"],"customFields":{}}"#)
            .decoded(as: ServerModelPolicy.self)
        XCTAssertTrue(policy.allowsProvider("anthropic"))
        XCTAssertFalse(policy.allowsProvider("openai"))
        XCTAssertTrue(policy.allowsModel("claude-sonnet-5"))
        XCTAssertFalse(policy.allowsModel("claude-haiku-4-5"), "a blocked model is refused even when allowed")
        XCTAssertFalse(policy.allowsModel("gpt-5"))
        XCTAssertTrue(ServerModelPolicy.none.allowsModel("anything"))
    }

    func testAWorkflowPromptMayUseOnlyItsPlaceholders() throws {
        let workflows = try ModelsFixtures.json(ModelsFixtures.workflows).decoded(as: [AIWorkflow].self)
        let merge = workflows[1]
        XCTAssertNil(merge.validationError("Merge {{directory}} with {{benchContext}}."))
        XCTAssertEqual(merge.validationError("{{directory}} {{branch}} {{branch}}"), "Unknown placeholder: {{branch}}")
        XCTAssertEqual(merge.validationError("{{a}} {{b}}"), "Unknown placeholders: {{a}}, {{b}}")
        XCTAssertNil(merge.validationError("{{ not a placeholder }}"))
    }

    func testProviderLabelsFollowTheDesktopRules() throws {
        let catalog = try ModelsFixtures.json(ModelsFixtures.catalog).decoded(as: ServerModelCatalog.self)
        let openai = try XCTUnwrap(catalog.providers.first { $0.id == "openai" })
        XCTAssertTrue(openai.hasManagedKey)
        XCTAssertTrue(openai.removesKeyOutright)
        XCTAssertTrue(openai.hasCustomGateway)
        let xai = try XCTUnwrap(catalog.providers.first { $0.id == "xai" })
        XCTAssertTrue(xai.cliSignInIsHostOnly)
        XCTAssertEqual(ServerProviderEntry.displayName(for: "groq", in: catalog.providers), "Groq")
        XCTAssertEqual(ServerProviderEntry.displayName(for: "acme-gw", in: []), "Acme-gw")
    }
}

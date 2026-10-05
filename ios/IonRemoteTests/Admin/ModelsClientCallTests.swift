import XCTest
@testable import IonRemote

/// Each provider, model, and agent-settings call sends the action and
/// arguments the server's handler reads, and a declined write throws its
/// reason instead of passing as success.
final class ModelsClientCallTests: XCTestCase {

    private func client(_ caller: FakeActionCaller) -> ServerAdminClient {
        ServerAdminClient(serverLabel: "Studio Mac", caller: caller)
    }

    func testCredentialAndSignInWritesSendTheProviderAndItsValue() async throws {
        let caller = FakeActionCaller(scopes: ["admin"])
        for action in [PhoneAction.providerStoreCredential, .providerLogin, .providerLoginCancel, .providerLoginCode, .providerLogout, .oauthLogout, .authCompleteSignIn] {
            caller.answer(action, with: .success(ModelsFixtures.ok))
        }
        let admin = client(caller)

        try await admin.storeCredential(provider: "openai", credential: "sk-test")
        try await admin.providerLogin(provider: "anthropic")
        try await admin.providerLoginCancel(provider: "anthropic")
        try await admin.providerLoginCode(provider: "anthropic", code: "code-1")
        try await admin.providerLogout(provider: "anthropic")
        try await admin.oauthLogout(provider: "google")
        try await admin.completeSignIn(flowId: "flow-1", callbackUrl: "http://127.0.0.1:8085/callback?code=c&state=s")

        XCTAssertEqual(caller.calls, [
            .init(action: "provider.storeCredential", args: [.object(["provider": .string("openai"), "credential": .string("sk-test")])]),
            .init(action: "provider.login", args: [.object(["provider": .string("anthropic")])]),
            .init(action: "provider.loginCancel", args: [.object(["provider": .string("anthropic")])]),
            .init(action: "provider.loginCode", args: [.object(["provider": .string("anthropic"), "code": .string("code-1")])]),
            .init(action: "provider.logout", args: [.object(["provider": .string("anthropic")])]),
            .init(action: "oauth.logout", args: [.object(["provider": .string("google")])]),
            .init(action: "auth.completeSignIn", args: [.object(["flowId": .string("flow-1"), "callbackUrl": .string("http://127.0.0.1:8085/callback?code=c&state=s")])]),
        ])
    }

    func testRemovingAProviderSendsItsIdAndThrowsTheServersRefusal() async throws {
        let caller = FakeActionCaller(scopes: ["admin"])
        caller.answer(.providerRemove, with: .success(ModelsFixtures.ok))
        let admin = client(caller)
        try await admin.removeProvider(provider: "corp-gateway")
        XCTAssertEqual(caller.calls, [.init(action: "provider.remove", args: [.object(["provider": .string("corp-gateway")])])])

        caller.answer(.providerRemove, with: .success(ModelsFixtures.declined("the default model corp-gateway/m comes from it")))
        do {
            try await admin.removeProvider(provider: "corp-gateway")
            XCTFail("a refused removal must throw")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("default model"))
        }
    }

    func testTierAndDefaultProviderWritesSendTheirShapes() async throws {
        let caller = FakeActionCaller(scopes: ["admin"])
        for action in [PhoneAction.modelSetTier, .modelRemoveTier, .providerSetDefault, .modelRefresh] {
            caller.answer(action, with: .success(ModelsFixtures.ok))
        }
        let admin = client(caller)

        try await admin.setModelTier(ModelTier(name: "review", model: "claude-sonnet-5", fallbacks: ["claude-haiku-4-5"]))
        try await admin.removeModelTier(name: "review")
        try await admin.setDefaultProvider("")
        try await admin.refreshModels(provider: "openai")
        try await admin.refreshModels(provider: nil)

        XCTAssertEqual(caller.calls, [
            .init(action: "model.setTier", args: [.object(["name": .string("review"), "model": .string("claude-sonnet-5"), "fallbacks": .array([.string("claude-haiku-4-5")])])]),
            .init(action: "model.removeTier", args: [.object(["name": .string("review")])]),
            .init(action: "provider.setDefault", args: [.object(["provider": .string("")])]),
            .init(action: "model.refresh", args: [.object(["provider": .string("openai")])]),
            .init(action: "model.refresh", args: [.object([:])]),
        ])
    }

    func testADeclinedWriteThrowsTheServersReason() async {
        let caller = FakeActionCaller(scopes: ["admin"])
        caller.answer(.providerStoreCredential, with: .success(ModelsFixtures.declined("provider and credential are required")))
        do {
            try await client(caller).storeCredential(provider: "openai", credential: "")
            XCTFail("expected the decline to throw")
        } catch {
            XCTAssertEqual(error.localizedDescription, "provider and credential are required")
        }
    }

    func testANullPolicyMeansNoNarrowing() async throws {
        let caller = FakeActionCaller(scopes: ["conversations:read"])
        caller.answer(.policyGetFull, with: .success(.null))
        let policy = try await client(caller).modelPolicy()
        XCTAssertEqual(policy, .none)
    }

    func testTheDevicePollWaitsAsLongAsTheCodeLives() async throws {
        let caller = TimeoutRecordingCaller()
        let code = GitHubDeviceCode(userCode: "WXYZ", verificationUri: "https://github.com/login/device", deviceCode: "dev-1", interval: 5, expiresIn: 900)
        try await ServerAdminClient(serverLabel: "Studio Mac", caller: caller).githubDevicePoll(code)
        XCTAssertEqual(caller.timeouts, [930])
        XCTAssertEqual(caller.args, [[.object(["deviceCode": .string("dev-1"), "interval": .double(5), "expiresIn": .double(900)])]])
    }

    func testAGitHubDeviceCodeThatFailsToStartThrows() async {
        let caller = FakeActionCaller(scopes: ["admin"])
        caller.answer(.oauthDeviceCode, with: .success(ModelsFixtures.declined("GitHub device code request failed: 503")))
        do {
            _ = try await client(caller).githubDeviceCode()
            XCTFail("expected a throw")
        } catch {
            XCTAssertEqual(error.localizedDescription, "GitHub device code request failed: 503")
        }
        XCTAssertEqual(caller.calls, [.init(action: "oauth.deviceCode", args: [.object(["provider": .string("github-copilot")])])])
    }

    func testAgentSettingsSaveTheirWholeEnvironmentKey() async throws {
        let caller = FakeActionCaller(scopes: ["admin"])
        let admin = client(caller)
        let profile = EngineProfile(id: "a1b2c3d4", name: "cos", extensions: ["/srv/ext/cos/index.ts"], defaultMode: "plan")

        try await admin.saveEngineProfiles([profile])
        try await admin.saveAIWorkflowPromptOverrides(["merge-resolution": "Merge {{directory}}."])

        XCTAssertEqual(caller.calls.map(\.action), ["settings.save", "settings.save"])
        XCTAssertEqual(caller.calls[0].args, [.object(["engineProfiles": .array([.object([
            "id": .string("a1b2c3d4"), "name": .string("cos"), "extensions": .array([.string("/srv/ext/cos/index.ts")]), "defaultMode": .string("plan"),
        ])])])])
        XCTAssertEqual(caller.calls[1].args, [.object(["aiAssistPromptOverrides": .object(["merge-resolution": .string("Merge {{directory}}.")])])])
    }

    func testTheWorkflowListIsReadThroughItsOwnAction() async throws {
        let caller = FakeActionCaller(scopes: ["conversations:read"])
        caller.answer(.aiAssistWorkflows, with: .success(ModelsFixtures.json(ModelsFixtures.workflows)))
        let workflows = try await client(caller).aiWorkflows()
        XCTAssertEqual(workflows.map(\.id), ["rebase-resolution", "merge-resolution"])
        XCTAssertEqual(caller.calls, [.init(action: "aiAssist.workflows", args: [])])
    }
}

/// Records the timeout each call asked for.
private final class TimeoutRecordingCaller: StudioActionCalling, @unchecked Sendable {
    private let lock = NSLock()
    private var recordedTimeouts: [Double?] = []
    private var recordedArgs: [[JSONValue]] = []
    var grantedScopes: [String]? { ["admin"] }
    var timeouts: [Double?] { lock.withLock { recordedTimeouts } }
    var args: [[JSONValue]] { lock.withLock { recordedArgs } }

    func call(_ action: String, args: [JSONValue], timeoutSeconds: Double?) async throws -> JSONValue {
        lock.withLock {
            recordedTimeouts.append(timeoutSeconds)
            recordedArgs.append(args)
        }
        return ModelsFixtures.ok
    }
}

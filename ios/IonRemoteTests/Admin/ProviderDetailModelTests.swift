import XCTest
@testable import IonRemote

/// A provider's screen follows the server's sign-in stages the way a client
/// that is not on the server's host must: device and pasted codes carry on,
/// a browser stage that needs the host is cancelled with the reason, and a
/// sign-in nobody finishes times out.
@MainActor
final class ProviderDetailModelTests: XCTestCase {

    private func make(
        scopes: [String] = ["admin"], startedTimeout: Duration = .seconds(120)
    ) async -> (ProviderDetailModel, ProvidersAdminModel, FakeActionCaller) {
        let caller = FakeActionCaller(scopes: scopes)
        caller.answer(.modelList, with: .success(ModelsFixtures.json(ModelsFixtures.catalog)))
        for action in [PhoneAction.providerLogin, .providerLoginCancel, .providerLoginCode, .providerStoreCredential] {
            caller.answer(action, with: .success(ModelsFixtures.ok))
        }
        let catalog = ProvidersAdminModel(client: ServerAdminClient(serverLabel: "Studio Mac", caller: caller), serverId: "srv", events: ServerAdminEvents())
        await catalog.load()
        let model = ProviderDetailModel(providerId: "openai", catalog: catalog, events: ServerAdminEvents(), startedTimeout: startedTimeout)
        return (model, catalog, caller)
    }

    private func stage(_ stage: String, backend: String = "codex", extra: String = "") -> ProviderLoginUpdate {
        do {
            return try ModelsFixtures.json(#"{"provider":"openai","backend":"\#(backend)","stage":"\#(stage)"\#(extra)}"#).decoded(as: ProviderLoginUpdate.self)
        } catch {
            preconditionFailure("bad stage fixture: \(error)")
        }
    }

    func testADeviceCodeStageShowsTheCodeAndItsPage() async {
        let (model, _, _) = await make()
        await model.apply(stage("started"))
        XCTAssertEqual(model.login, .waiting(userCode: nil, verificationUrl: nil))
        await model.apply(stage("await_device_code", extra: #","userCode":"ABCD-1234","verificationUrl":"https://auth.example.org/device""#))
        XCTAssertEqual(model.login, .waiting(userCode: "ABCD-1234", verificationUrl: "https://auth.example.org/device"))
        model.stop()
    }

    func testABrowserStageThatNeedsTheHostIsCancelledWithTheReason() async {
        let (model, _, caller) = await make()
        await model.apply(stage("await_browser", extra: #","authUrl":"http://localhost:1455/auth""#))
        XCTAssertEqual(model.login, .failed(ProviderDetailModel.hostOnlyRefusal))
        XCTAssertEqual(caller.calls.last, .init(action: "provider.loginCancel", args: [.object(["provider": .string("openai")])]))
        // The cancel echoes back; the reason stays on screen.
        await model.apply(stage("cancelled"))
        XCTAssertEqual(model.login, .failed(ProviderDetailModel.hostOnlyRefusal))
    }

    func testClaudeCodesBrowserStageCarriesOnToThePastedCode() async {
        let (model, _, caller) = await make()
        await model.apply(stage("await_browser", backend: "claude-code"))
        XCTAssertEqual(model.login, .waiting(userCode: nil, verificationUrl: nil))
        await model.apply(stage("await_auth_code", backend: "claude-code", extra: #","authUrl":"https://claude.ai/oauth/authorize?x=1""#))
        XCTAssertEqual(model.login, .awaitingCode(signInUrl: "https://claude.ai/oauth/authorize?x=1"))
        XCTAssertFalse(caller.calls.contains { $0.action == "provider.loginCancel" })

        let submitted = await model.submitCode("  code-1 \n")
        XCTAssertTrue(submitted)
        XCTAssertEqual(caller.calls.last, .init(action: "provider.loginCode", args: [.object(["provider": .string("openai"), "code": .string("code-1")])]))
        model.stop()
    }

    func testACompletedSignInClearsTheStageAndAFailedOneShowsItsError() async {
        let (model, _, _) = await make()
        await model.apply(stage("started"))
        await model.apply(stage("completed"))
        XCTAssertNil(model.login)
        XCTAssertEqual(model.notice, "Signed in.")
        await model.apply(stage("failed", extra: #","loginError":"codex exited with status 1""#))
        XCTAssertEqual(model.login, .failed("codex exited with status 1"))
    }

    func testASignInNobodyFinishesTimesOutAndIsCancelled() async {
        let (model, _, caller) = await make(startedTimeout: .milliseconds(20))
        await model.apply(stage("started"))
        await waitUntil("the sign-in times out") { await MainActor.run { model.login == .failed(ProviderDetailModel.timedOut) } }
        await waitUntil("the cancel is sent") { caller.calls.last?.action == "provider.loginCancel" }
    }

    func testAKeyWithoutAdminIsRefusedBeforeItIsSent() async {
        let (model, _, caller) = await make(scopes: ["conversations:read"])
        let saved = await model.saveKey("sk-test")
        XCTAssertFalse(saved)
        XCTAssertEqual(model.error, "Needs admin access on Studio Mac. Pair again with a link that grants it.")
        XCTAssertFalse(caller.calls.contains { $0.action == "provider.storeCredential" })
    }

    func testASavedKeyReloadsTheProvider() async {
        let (model, _, caller) = await make()
        let saved = await model.saveKey(" sk-test ")
        XCTAssertTrue(saved)
        XCTAssertEqual(model.notice, "API key saved.")
        let calls = caller.calls
        let stored = calls.lastIndex { $0.action == "provider.storeCredential" }
        XCTAssertEqual(stored.map { calls[$0].args }, [.object(["provider": .string("openai"), "credential": .string("sk-test")])])
        XCTAssertTrue(calls.suffix(from: (stored ?? 0) + 1).contains { $0.action == "model.list" }, "the list reloads after the save")
    }
}

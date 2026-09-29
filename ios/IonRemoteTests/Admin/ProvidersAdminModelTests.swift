import XCTest
@testable import IonRemote

/// The provider list shows what the server's policy permits, signed-in
/// providers first, and reloads when a sign-in completes.
@MainActor
final class ProvidersAdminModelTests: XCTestCase {

    func testSignedInProvidersComeFirstAndThePolicyNarrowsTheList() async {
        let caller = FakeActionCaller(scopes: ["conversations:read"])
        caller.answer(.modelList, with: .success(ModelsFixtures.json(ModelsFixtures.catalog)))
        caller.answer(.policyGetFull, with: .success(ModelsFixtures.json(#"{"allowedProviders":["groq","anthropic","openai"]}"#)))
        let model = ProvidersAdminModel(client: ServerAdminClient(serverLabel: "Studio Mac", caller: caller), serverId: "srv", events: ServerAdminEvents())

        XCTAssertNil(model.catalog, "nothing shows before the first load")
        await model.load()

        XCTAssertEqual(model.providers.map(\.id), ["anthropic", "openai", "groq"])
        XCTAssertEqual(model.modelCount(for: "anthropic"), 2)
    }

    func testAFailedPolicyReadShowsEveryProvider() async {
        let caller = FakeActionCaller(scopes: ["conversations:read"])
        caller.answer(.modelList, with: .success(ModelsFixtures.json(ModelsFixtures.catalog)))
        caller.answer(.policyGetFull, with: .failure(StudioActionFailure.failed(code: "action_failed", message: "engine down")))
        let model = ProvidersAdminModel(client: ServerAdminClient(serverLabel: "Studio Mac", caller: caller), serverId: "srv", events: ServerAdminEvents())
        await model.load()
        XCTAssertEqual(model.providers.count, 5)
        XCTAssertNil(model.error)
    }

    func testACompletedSignInReloadsTheList() async {
        let caller = FakeActionCaller(scopes: ["conversations:read"])
        caller.answer(.modelList, with: .success(ModelsFixtures.json(ModelsFixtures.catalog)))
        let events = ServerAdminEvents()
        let model = ProvidersAdminModel(client: ServerAdminClient(serverLabel: "Studio Mac", caller: caller), serverId: "srv", events: events)
        let following = Task { await model.follow() }
        await waitUntil("the first load") { caller.calls.filter { $0.action == "model.list" }.count == 1 }

        events.publish(ServerAdminEvent(serverId: "srv", channel: ServerAdminEvent.providerLoginEvent,
                                        payload: ModelsFixtures.json(#"{"provider":"openai","backend":"codex","stage":"completed"}"#)))

        await waitUntil("a reload") { caller.calls.filter { $0.action == "model.list" }.count == 2 }
        following.cancel()
    }
}

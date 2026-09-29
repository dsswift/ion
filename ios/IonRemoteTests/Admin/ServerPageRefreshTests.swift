import XCTest
@testable import IonRemote

/// Pulling a server page down reloads every section registered on it, waits
/// for all of them, and skips a section that has left the screen.
@MainActor
final class ServerPageRefreshTests: XCTestCase {

    /// What the reloads ran, in order.
    @MainActor
    private final class Reloaded {
        var names: [String] = []
    }

    func testARefreshRunsEveryRegisteredReloadAndWaitsForThem() async {
        let refresh = ServerPageRefresh(serverId: "srv", pageId: "models")
        let reloaded = Reloaded()
        refresh.register("providers") { [reloaded] in reloaded.names.append("providers") }
        refresh.register("ai") { [reloaded] in
            try? await Task.sleep(for: .milliseconds(20)) // benign: only delays the append
            reloaded.names.append("ai")
        }

        await refresh.refresh()

        XCTAssertEqual(reloaded.names.sorted(), ["ai", "providers"])
    }

    func testASectionThatLeftIsNotReloaded() async {
        let refresh = ServerPageRefresh(serverId: "srv", pageId: "models")
        let reloaded = Reloaded()
        refresh.register("providers") { [reloaded] in reloaded.names.append("providers") }
        refresh.register("ai") { [reloaded] in reloaded.names.append("ai") }
        refresh.unregister("ai")

        await refresh.refresh()

        XCTAssertEqual(reloaded.names, ["providers"])
        XCTAssertEqual(refresh.registeredIds, ["providers"])
    }

    func testRegisteringAgainReplacesTheReload() async {
        let refresh = ServerPageRefresh(serverId: "srv", pageId: "models")
        let reloaded = Reloaded()
        refresh.register("ai") { [reloaded] in reloaded.names.append("first") }
        refresh.register("ai") { [reloaded] in reloaded.names.append("second") }

        await refresh.refresh()

        XCTAssertEqual(reloaded.names, ["second"])
    }

    func testARefreshReloadsASectionModelFromTheServer() async {
        let caller = FakeActionCaller(scopes: ["conversations:read"])
        caller.answer(.settingsLoad, with: .success(ModelsFixtures.json(ModelsFixtures.settings)))
        caller.answer(.modelList, with: .success(ModelsFixtures.json(ModelsFixtures.catalog)))
        caller.answer(.policyGetFull, with: .success(ModelsFixtures.json("{}")))
        let model = DefaultModelsModel(client: ServerAdminClient(serverLabel: "Studio Mac", caller: caller), serverId: "srv")
        let refresh = ServerPageRefresh(serverId: "srv", pageId: "models")
        refresh.register("ai") { [model] in await model.load() }

        await refresh.refresh()

        XCTAssertTrue(model.loaded)
        XCTAssertEqual(caller.calls.filter { $0.action == PhoneAction.settingsLoad.rawValue }.count, 1)
    }
}

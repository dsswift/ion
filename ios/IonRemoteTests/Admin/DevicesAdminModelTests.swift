import XCTest
@testable import IonRemote

/// The paired devices list: live pairings only, re-read when the server says
/// they changed, and this phone's own pairing never revoked from here.
@MainActor
final class DevicesAdminModelTests: XCTestCase {

    private let serverId = "own-pairing"

    private func make(_ caller: FakeActionCaller, events: ServerAdminEvents = ServerAdminEvents()) -> DevicesAdminModel {
        DevicesAdminModel(client: ServerAdminClient(serverLabel: "Studio Mac", caller: caller), serverId: serverId, ownClientId: serverId, events: events)
    }

    func testLoadKeepsLivePairingsMostRecentlySeenFirst() async {
        let caller = FakeActionCaller(scopes: ["admin"])
        caller.answer(.authListClients, with: .success(.array([
            AccessFixtures.client("old", lastSeen: 1), AccessFixtures.client("gone", revokedAt: 5), AccessFixtures.client(serverId, lastSeen: 9),
        ])))
        let model = make(caller)
        XCTAssertFalse(model.loaded)

        await model.load()

        XCTAssertTrue(model.loaded)
        XCTAssertEqual(model.clients.map(\.clientId), [serverId, "old"])
        XCTAssertTrue(model.isOwn(model.clients[0]))
    }

    func testAFailedLoadSaysWhyAndStaysUnloaded() async {
        let caller = FakeActionCaller(scopes: ["admin"])
        caller.answer(.authListClients, with: .failure(StudioActionFailure.failed(code: "boom", message: "The server could not read its pairings.")))
        let model = make(caller)

        await model.load()

        XCTAssertFalse(model.loaded)
        XCTAssertEqual(model.loadError, "The server could not read its pairings.")
    }

    func testANewPairingAnnouncedByTheServerIsReadAgain() async {
        let caller = FakeActionCaller(scopes: ["admin"])
        caller.answer(.authListClients, with: .success(.array([AccessFixtures.client("a")])))
        let events = ServerAdminEvents()
        let model = make(caller, events: events)
        await model.load()
        let watcher = Task { await model.watch() }
        await waitUntil("the watcher subscribed") { await Task.yield(); return true }

        caller.answer(.authListClients, with: .success(.array([AccessFixtures.client("a"), AccessFixtures.client("b", lastSeen: 1_800_000_000_000)])))
        events.publish(ServerAdminEvent(serverId: "someone-else", channel: ServerAdminEvent.clientsChanged, payload: .null))
        events.publish(ServerAdminEvent(serverId: serverId, channel: ServerAdminEvent.clientsChanged, payload: .null))

        await waitUntil("the list re-read") { await MainActor.run { model.clients.count == 2 } }
        XCTAssertEqual(model.clients.map(\.clientId), ["b", "a"])
        watcher.cancel()
    }

    func testThisPhonesOwnPairingIsNeverRevoked() async throws {
        let caller = FakeActionCaller(scopes: ["admin"])
        caller.answer(.authListClients, with: .success(.array([AccessFixtures.client(serverId)])))
        let model = make(caller)
        await model.load()

        let revoked = await model.revoke(model.clients[0])

        XCTAssertFalse(revoked)
        XCTAssertEqual(model.revokeError, DevicesAdminModel.ownPairingReason)
        XCTAssertFalse(caller.calls.map(\.action).contains("auth.revokeClient"))
    }

    func testRevokeRemovesTheDevice() async {
        let caller = FakeActionCaller(scopes: ["admin"])
        caller.answer(.authListClients, with: .success(.array([AccessFixtures.client("other")])))
        caller.answer(.authRevokeClient, with: .success(.object(["revoked": .bool(true), "closed": .int(1)])))
        let model = make(caller)
        await model.load()
        caller.answer(.authListClients, with: .success(.array([AccessFixtures.client("other", revokedAt: 7)])))

        let revoked = await model.revoke(model.clients[0])

        XCTAssertTrue(revoked)
        XCTAssertEqual(model.clients, [])
        XCTAssertTrue(caller.calls.contains(.init(action: "auth.revokeClient", args: [.object(["clientId": .string("other")])])))
    }

    func testAPhoneWithoutAdminIsRefusedBeforeAnythingIsSent() async {
        let caller = FakeActionCaller(scopes: ["conversations:read", "conversations:operate"])
        let model = make(caller)

        await model.load()

        XCTAssertEqual(model.loadError, "Needs admin access on Studio Mac. Pair again with a link that grants it.")
        XCTAssertEqual(caller.calls, [])
    }
}

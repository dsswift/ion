import XCTest
@testable import IonRemote

/// Discovery: the status, re-read on every announcement, and its verbs.
@MainActor
final class DiscoveryAdminModelTests: XCTestCase {

    private let serverId = "server-a"

    func testLoadThenOpenThenAWindowClosingItselfIsSeen() async {
        let caller = FakeActionCaller(scopes: ["admin"])
        caller.answer(.environmentDiscoveryStatus, with: .success(AccessFixtures.discovery("off")))
        caller.answer(.environmentDiscoveryOpen, with: .success(AccessFixtures.discovery("window", until: 1_700_000_900_000, code: "ABCD-2345")))
        let events = ServerAdminEvents()
        let model = DiscoveryAdminModel(client: ServerAdminClient(serverLabel: "Studio Mac", caller: caller), serverId: serverId, events: events)

        await model.load()
        XCTAssertEqual(model.status?.mode, .off)

        await model.open(minutes: 60)
        XCTAssertEqual(model.status?.mode, .window)
        XCTAssertEqual(model.status?.code, "ABCD-2345")

        let watcher = Task { await model.watch() }
        await waitUntil("the watcher subscribed") { await Task.yield(); return true }
        events.publish(ServerAdminEvent(serverId: serverId, channel: ServerAdminEvent.discovery, payload: .object(["mode": .string("off")])))
        await waitUntil("the closed window was read") { await MainActor.run { model.status?.mode == .off } }
        watcher.cancel()
    }

    func testAPersistentServerMintsACodeAndARefusalIsShown() async {
        let caller = FakeActionCaller(scopes: ["admin"])
        caller.answer(.environmentDiscoveryMintCode, with: .success(.object(["code": .string("WXYZ-2345"), "expiresAt": .int(1)])))
        let model = DiscoveryAdminModel(client: ServerAdminClient(serverLabel: "Studio Mac", caller: caller), serverId: serverId)

        await model.mintCode()
        XCTAssertEqual(model.mintedCode?.code, "WXYZ-2345")

        caller.answer(.environmentDiscoveryOpen, with: .failure(StudioActionFailure.refused(code: "sealed", message: "LAN discovery is disabled by your organization.")))
        await model.open(minutes: 15)
        XCTAssertEqual(model.actionError, "LAN discovery is disabled by your organization.")
        XCTAssertFalse(model.busy)
    }
}

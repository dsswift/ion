import XCTest
@testable import IonRemote

/// Phone and relay: the name on phones, and a relay tested by the server
/// before it is saved.
@MainActor
final class PhoneRelayModelsTests: XCTestCase {

    private let serverId = "server-a"

    private func client(_ caller: FakeActionCaller) -> ServerAdminClient {
        ServerAdminClient(serverLabel: "Studio Mac", caller: caller)
    }

    func testLoadReadsTheDisplayAndTheRelayAndProbesItsMode() async {
        let caller = FakeActionCaller(scopes: ["admin"])
        caller.answer(.remoteGetDisplay, with: .success(.null))
        caller.answer(.settingsLoad, with: .success(.object(["relayUrl": .string("wss://relay.example.org"), "relayApiKey": .string("")])))
        caller.answer(.remoteRelayAuthConfig, with: .success(AccessFixtures.entraRelay))
        let model = PhoneRelayAdminModel(client: client(caller), serverId: serverId, canProbeRelay: { true })

        await model.load()

        XCTAssertTrue(model.displayLoaded)
        XCTAssertNil(model.display)
        XCTAssertEqual(model.relay?.relayUrl, "wss://relay.example.org")
        XCTAssertEqual(model.relayAuth?.oidc, true)
    }

    func testWithoutAdminTheRelayIsReadButNotProbed() async {
        let caller = FakeActionCaller(scopes: ["conversations:read", "conversations:operate"])
        caller.answer(.settingsLoad, with: .success(.object(["relayUrl": .string("wss://relay.example.org")])))
        let model = PhoneRelayAdminModel(client: client(caller), serverId: serverId, canProbeRelay: { false })

        await model.loadRelay()

        XCTAssertEqual(model.relay?.isConfigured, true)
        XCTAssertNil(model.relayAuth)
        XCTAssertFalse(caller.calls.map(\.action).contains("remote.relayAuthConfig"))
    }

    func testABlankNameSavesAsTheHostName() async {
        let caller = FakeActionCaller(scopes: ["conversations:operate"])
        caller.answer(.remoteSetDisplay, with: .success(.object(["customName": .null, "customIcon": .string("house"), "updatedAt": .int(3000)])))
        let model = PhoneRelayAdminModel(client: client(caller), serverId: serverId, canProbeRelay: { false })

        let saved = await model.saveDisplay(name: "   ", icon: "house", now: Date(timeIntervalSince1970: 3))

        XCTAssertTrue(saved)
        XCTAssertEqual(model.display?.customIcon, "house")
        XCTAssertEqual(caller.calls.last, .init(action: "remote.setDisplay", args: [.null, .string("house"), .int(3000)]))
    }

    func testRemovingTheRelayClearsUrlAndKey() async {
        let caller = FakeActionCaller(scopes: ["admin"])
        let model = PhoneRelayAdminModel(client: client(caller), serverId: serverId, canProbeRelay: { true })

        await model.removeRelay()

        XCTAssertEqual(model.relay, RelaySettings(relayUrl: "", relayApiKey: ""))
        XCTAssertEqual(caller.calls, [.init(action: "settings.save", args: [.object(["relayUrl": .string(""), "relayApiKey": .string("")])])])
    }

    func testASharedKeyRelayIsTestedBeforeItIsSaved() async {
        let caller = FakeActionCaller(scopes: ["admin"])
        caller.answer(.remoteRelayAuthConfig, with: .success(AccessFixtures.pskRelay))
        caller.answer(.remoteTestRelay, with: .success(.object(["success": .bool(false), "error": .string("bad key")])))
        let model = RelayEditModel(client: client(caller), serverId: serverId, current: RelaySettings(relayUrl: "", relayApiKey: ""))
        model.url = " wss://relay.example.org "
        model.apiKey = "wrong"
        await model.probe()
        XCTAssertTrue(model.probeCurrent)
        XCTAssertFalse(model.isEntra)

        let refused = await model.save()
        XCTAssertNil(refused)
        XCTAssertEqual(model.error, "The server could not connect: bad key")
        XCTAssertFalse(caller.calls.map(\.action).contains("settings.save"))

        caller.answer(.remoteTestRelay, with: .success(.object(["success": .bool(true)])))
        model.apiKey = "right"
        let saved = await model.save()
        XCTAssertEqual(saved, RelaySettings(relayUrl: "wss://relay.example.org", relayApiKey: "right"))
        XCTAssertEqual(caller.calls.last, .init(action: "settings.save", args: [.object(["relayUrl": .string("wss://relay.example.org"), "relayApiKey": .string("right")])]))
    }

    func testAnEntraRelaySavesWithNoKeyOnlyOnceTheServerIsSignedIn() async {
        let caller = FakeActionCaller(scopes: ["admin"])
        caller.answer(.remoteRelayAuthConfig, with: .success(AccessFixtures.entraRelay))
        caller.answer(.entraIdentity, with: .success(.object(["identity": .null])))
        let model = RelayEditModel(client: client(caller), serverId: serverId, current: RelaySettings(relayUrl: "wss://relay.example.org", relayApiKey: "old"))
        await model.probe()
        XCTAssertTrue(model.isEntra)
        XCTAssertNil(model.signedInUser)
        let refused = await model.save()
        XCTAssertNil(refused)

        caller.answer(.entraIdentity, with: .success(.object(["identity": .object([
            "user": .string("user@example.com"), "username": .string("user@example.com"), "displayName": .string("A user"), "oid": .string("o1"),
        ])])))
        await model.probe()
        XCTAssertEqual(model.signedInUser, "user@example.com")
        let saved = await model.save()
        XCTAssertEqual(saved, RelaySettings(relayUrl: "wss://relay.example.org", relayApiKey: ""))
        XCTAssertFalse(caller.calls.map(\.action).contains("remote.testRelay"))
    }

    func testRelaysFoundOnTheServersNetworkArriveAndDiscoveryStops() async {
        let caller = FakeActionCaller(scopes: ["admin"])
        caller.answer(.remoteDiscoverRelays, with: .success(.array([])))
        caller.answer(.remoteRelayAuthConfig, with: .success(AccessFixtures.pskRelay))
        let events = ServerAdminEvents()
        let model = RelayEditModel(client: client(caller), serverId: serverId, current: RelaySettings(relayUrl: "", relayApiKey: ""), events: events)
        await model.startDiscovery()
        XCTAssertTrue(model.discovering)
        let watcher = Task { await model.watch() }
        await waitUntil("the watcher subscribed") { await Task.yield(); return true }

        events.publish(ServerAdminEvent(serverId: serverId, channel: ServerAdminEvent.remoteRelaysChanged, payload: .array([.object([
            "id": .string("r1"), "name": .string("Office relay"), "host": .string("relay.local"), "port": .int(8080), "addresses": .array([.string("192.0.2.5")]),
        ])])))
        await waitUntil("the relay arrived") { await MainActor.run { model.discovered.count == 1 } }

        await model.pick(model.discovered[0])
        XCTAssertEqual(model.url, "ws://192.0.2.5:8080")
        XCTAssertFalse(model.discovering)
        XCTAssertTrue(caller.calls.map(\.action).contains("remote.stopDiscovery"))
        watcher.cancel()
    }
}

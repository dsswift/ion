import XCTest
@testable import IonRemote

/// Pairing a phone: a link with the server's own pairing scopes, a code when discovery can
/// give one, and a finish that closes any window this opened.
@MainActor
final class PairPhoneModelTests: XCTestCase {

    private let serverId = "server-a"

    private func make(_ caller: FakeActionCaller, events: ServerAdminEvents = ServerAdminEvents()) -> PairPhoneModel {
        PairPhoneModel(client: ServerAdminClient(serverLabel: "Studio Mac", caller: caller), serverId: serverId, events: events)
    }

    private func caller(discovery: JSONValue) -> FakeActionCaller {
        let caller = FakeActionCaller(scopes: ["admin"])
        caller.answer(.authListClients, with: .success(.array([AccessFixtures.client("existing")])))
        caller.answer(.authCreatePairingLink, with: .success(AccessFixtures.link()))
        caller.answer(.environmentDiscoveryStatus, with: .success(discovery))
        caller.answer(.environmentDiscoveryOpen, with: .success(AccessFixtures.discovery("window", until: 1, code: "ABCD-2345")))
        caller.answer(.environmentDiscoveryClose, with: .success(AccessFixtures.discovery("off")))
        return caller
    }

    func testAnUndiscoverableServerOpensAWindowForTheCodeAndClosesItAfterward() async {
        let caller = caller(discovery: AccessFixtures.discovery("off"))
        let events = ServerAdminEvents()
        let model = make(caller, events: events)

        await model.start()

        XCTAssertEqual(model.offer?.code, "ABCD-2345")
        XCTAssertEqual(model.offer?.url, "ion-studio://pair?code=ABCD2345&host=192.0.2.4")
        XCTAssertTrue(model.openedWindow)
        XCTAssertTrue(caller.calls.contains(.init(action: "environment.discovery.open", args: [.object(["minutes": .int(15)])])))

        let watcher = Task { await model.watch() }
        await waitUntil("the watcher subscribed") { await Task.yield(); return true }
        caller.answer(.authListClients, with: .success(.array([AccessFixtures.client("existing"), AccessFixtures.client("new-phone")])))
        events.publish(ServerAdminEvent(serverId: serverId, channel: ServerAdminEvent.clientsChanged, payload: .null))

        await waitUntil("the pairing landed") { await MainActor.run { model.outcome == .paired } }
        await waitUntil("the window closed") { caller.calls.map(\.action).contains("environment.discovery.close") }
        watcher.cancel()
    }

    func testThePhoneLinkAsksForNoScopesSoTheServerDefaultsApply() async {
        let caller = caller(discovery: AccessFixtures.discovery("sealed"))
        await make(caller).start()
        XCTAssertTrue(caller.calls.contains(.init(action: "auth.createPairingLink", args: [.object(["label": .string("Phone")])])))
    }

    func testASealedServerOffersTheQRCodeAloneAndOpensNothing() async {
        let caller = caller(discovery: AccessFixtures.discovery("sealed"))
        let model = make(caller)

        await model.start()

        XCTAssertNotNil(model.offer)
        XCTAssertNil(model.offer?.code)
        XCTAssertFalse(caller.calls.map(\.action).contains("environment.discovery.open"))
        await model.finish(.cancelled)
        XCTAssertFalse(caller.calls.map(\.action).contains("environment.discovery.close"))
    }

    func testAnOpenWindowsCodeIsReusedAndLeftOpen() async {
        let caller = caller(discovery: AccessFixtures.discovery("window", until: 1, code: "WXYZ-2345"))
        let model = make(caller)

        await model.start()
        await model.finish(.cancelled)

        XCTAssertEqual(model.offer?.code, "WXYZ-2345")
        XCTAssertFalse(caller.calls.map(\.action).contains("environment.discovery.close"))
    }

    func testTheOfferEndsWhenTheLinkExpires() async {
        let caller = caller(discovery: AccessFixtures.discovery("sealed"))
        let model = make(caller)
        await model.start()
        let expiry = model.offer?.expiresAt ?? Date()

        await model.tick(now: expiry.addingTimeInterval(-1))
        XCTAssertNil(model.outcome)
        await model.tick(now: expiry)
        XCTAssertEqual(model.outcome, .expired)
    }

    func testAFailedMintSaysWhy() async {
        let caller = caller(discovery: AccessFixtures.discovery("off"))
        caller.answer(.authCreatePairingLink, with: .failure(StudioActionFailure.refused(code: "scope", message: "requested scopes exceed your granted scopes")))
        let model = make(caller)

        await model.start()

        XCTAssertNil(model.offer)
        XCTAssertEqual(model.error, "requested scopes exceed your granted scopes")
    }
}

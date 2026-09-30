import XCTest
@testable import IonRemote

/// The provider subscription on a server: the snapshot decoding, the id the
/// selection sends, a refused action keeping the state it left, and the model
/// following the pushed snapshot.
@MainActor
final class ProviderSubscriptionAdminTests: XCTestCase {

    private let caller = FakeActionCaller(scopes: nil)
    private var client: ServerAdminClient { ServerAdminClient(serverLabel: "Studio Mac", caller: caller) }

    private static let choosing = #"{"ok":true,"subscription":{"state":"selection_required","provider":"gateway","options":[{"id":"std","label":"Standard"},{"id":"prem","label":"High quota"}],"resolvedAt":1700000000000}}"#
    private static let applied = #"{"ok":true,"subscription":{"state":"applied","provider":"gateway","selected":{"id":"prem","label":"High quota"},"options":[{"id":"std","label":"Standard"},{"id":"prem","label":"High quota"}],"source":"lookup"}}"#

    func testStateDecodesAndSelectionSendsTheId() async throws {
        caller.answer(.providerSubscription, with: .success(IntegrationsFixtures.json(Self.choosing)))
        caller.answer(.providerSelectSubscription, with: .success(IntegrationsFixtures.json(Self.applied)))
        let read = try await client.providerSubscription()
        XCTAssertEqual(read.subscription.state, ProviderSubscriptionStatus.State.selectionRequired)
        XCTAssertEqual(read.subscription.options?.map(\.label), ["Standard", "High quota"])

        let model = ProviderSubscriptionModel(serverId: "s", client: client)
        await model.select(id: "prem")
        XCTAssertEqual(model.status?.selected, SubscriptionOption(id: "prem", label: "High quota"))
        XCTAssertNil(model.operationError)
        XCTAssertEqual(caller.calls.last, .init(action: "provider.selectSubscription", args: [.object(["id": .string("prem")])]))
    }

    func testARefusedRefreshKeepsTheStateItLeft() async {
        caller.answer(.providerRefreshSubscription, with: .success(IntegrationsFixtures.json(
            #"{"ok":false,"error":"endpoint returned status 503","subscription":{"state":"failed","provider":"gateway","error":"endpoint returned status 503"}}"#
        )))
        let model = ProviderSubscriptionModel(serverId: "s", client: client)
        await model.refresh()
        XCTAssertEqual(model.status?.state, ProviderSubscriptionStatus.State.failed)
        XCTAssertEqual(model.operationError, "endpoint returned status 503")
        XCTAssertEqual(ProviderSubscriptionRows.describe(model.status!), "The subscription lookup failed. Any key entered by hand is still in use.")
    }

    func testNoSubscriptionIsExplained() throws {
        let none = try IntegrationsFixtures.json(#"{"state":"none","provider":"gateway"}"#).decoded(as: ProviderSubscriptionStatus.self)
        XCTAssertEqual(ProviderSubscriptionRows.providerName(none), "gateway")
        let named = try IntegrationsFixtures.json(#"{"state":"none","provider":"gateway","providerDisplayName":"Corporate Gateway"}"#).decoded(as: ProviderSubscriptionStatus.self)
        XCTAssertEqual(ProviderSubscriptionRows.providerName(named), "Corporate Gateway")
        XCTAssertEqual(ProviderSubscriptionRows.describe(none), "The account has no subscription. Contact your administrator for access.")
    }

    func testTheModelFollowsTheSubscriptionChannel() async {
        caller.answer(.providerSubscription, with: .success(IntegrationsFixtures.json(Self.choosing)))
        let events = ServerAdminEvents()
        let model = ProviderSubscriptionModel(serverId: "s", client: client, events: events)
        let task = Task { await model.follow() }
        defer { task.cancel() }
        await waitUntil("read") { await MainActor.run { model.status?.state == ProviderSubscriptionStatus.State.selectionRequired } }
        events.publish(ServerAdminEvent(serverId: "s", channel: ServerAdminEvent.providerSubscriptionChanged,
                                        payload: IntegrationsFixtures.json(#"{"state":"applied","provider":"gateway","selected":{"id":"std","label":"Standard"},"source":"cache"}"#)))
        await waitUntil("snapshot applied") { await MainActor.run { model.status?.selected?.id == "std" } }
    }
}

import XCTest
@testable import IonRemote

/// The Provider Subscription Prompt: it appears for a server whose lookup
/// needs a person, once per transition into that state, applies the
/// subscription chosen, looks up again, and stays away when no lookup is
/// configured or a key is applied.
@MainActor
final class SubscriptionPromptTests: XCTestCase {

    private let caller = FakeActionCaller(scopes: nil)
    private var client: ServerAdminClient { ServerAdminClient(serverLabel: "Studio Mac", caller: caller) }

    private static let choosing = #"{"state":"selection_required","provider":"gateway","providerDisplayName":"Corporate Gateway","options":[{"id":"std","label":"Standard"},{"id":"prem","label":"High quota"}]}"#
    private static let none = #"{"state":"none","provider":"gateway","providerDisplayName":"Corporate Gateway"}"#
    private static let applied = #"{"state":"applied","provider":"gateway","selected":{"id":"prem","label":"High quota"},"source":"lookup"}"#

    private func status(_ json: String) throws -> ProviderSubscriptionStatus {
        try IntegrationsFixtures.json(json).decoded(as: ProviderSubscriptionStatus.self)
    }

    private func result(_ json: String, ok: Bool = true) -> JSONValue {
        IntegrationsFixtures.json(#"{"ok":\#(ok),"subscription":\#(json)}"#)
    }

    func testOnlyTheTwoStatesThatNeedAPersonAsk() throws {
        for state in ["disabled", "awaiting_identity", "resolving", "applied", "failed"] {
            XCTAssertNil(SubscriptionAttention.state(of: try status(#"{"state":"\#(state)"}"#)), state)
        }
        XCTAssertEqual(SubscriptionAttention.state(of: try status(Self.choosing)), "selection_required")
        XCTAssertEqual(SubscriptionAttention.state(of: try status(Self.none)), "none")
        XCTAssertNil(SubscriptionAttention.state(of: nil))
    }

    func testThePromptShowsOncePerTransition() throws {
        let model = SubscriptionPromptModel(events: ServerAdminEvents())
        model.apply(serverId: "s", status: try status(Self.choosing), source: "read")
        XCTAssertEqual(model.prompt(for: "s")?.state, "selection_required")

        model.dismiss(serverId: "s")
        XCTAssertNil(model.prompt(for: "s"))
        // The same state broadcast again is not a new transition.
        model.apply(serverId: "s", status: try status(Self.choosing), source: "push")
        XCTAssertNil(model.prompt(for: "s"))

        // Leaving the state and entering it again is.
        model.apply(serverId: "s", status: try status(#"{"state":"resolving","provider":"gateway"}"#), source: "push")
        model.apply(serverId: "s", status: try status(Self.choosing), source: "push")
        XCTAssertEqual(model.prompt(for: "s")?.state, "selection_required")

        // So is one state giving way to the other.
        model.dismiss(serverId: "s")
        model.apply(serverId: "s", status: try status(Self.none), source: "push")
        XCTAssertEqual(model.prompt(for: "s")?.state, "none")
    }

    func testNoLookupAndAnAppliedKeyNeverAsk() throws {
        let model = SubscriptionPromptModel(events: ServerAdminEvents())
        model.apply(serverId: "s", status: try status(#"{"state":"disabled"}"#), source: "read")
        XCTAssertNil(model.prompt(for: "s"))
        model.apply(serverId: "s", status: try status(Self.applied), source: "push")
        XCTAssertNil(model.prompt(for: "s"))
    }

    func testChoosingSendsTheIdAndClosesThePrompt() async throws {
        caller.answer(.providerSelectSubscription, with: .success(result(Self.applied)))
        let model = SubscriptionPromptModel(events: ServerAdminEvents())
        model.apply(serverId: "s", status: try status(Self.choosing), source: "read")
        let prompt = try XCTUnwrap(model.prompt(for: "s"))
        XCTAssertEqual(ProviderSubscriptionPromptCard.title(prompt), "Choose a Corporate Gateway subscription")
        XCTAssertEqual(prompt.status.options?.map(\.label), ["Standard", "High quota"])

        await model.select(serverId: "s", id: "prem", client: client)
        XCTAssertEqual(caller.calls.last, .init(action: "provider.selectSubscription", args: [.object(["id": .string("prem")])]))
        XCTAssertNil(model.prompt(for: "s"))
        XCTAssertNil(model.operationError)
    }

    func testAFailureStateUsesThePolicyTextWhenConfigured() throws {
        let configured = try status(#"{"state":"none","provider":"gateway","policyFailure":"subscription_unavailable","message":"Open a ticket to request access."}"#)
        XCTAssertEqual(configured.policyFailure, "subscription_unavailable")
        XCTAssertEqual(configured.failureText("default"), "Open a ticket to request access.")
        XCTAssertEqual(ProviderSubscriptionRows.describe(configured), "Open a ticket to request access.")
        let attention = try XCTUnwrap(SubscriptionAttention.next(previous: nil, status: configured))
        XCTAssertEqual(ProviderSubscriptionPromptCard.explanation(attention), "Open a ticket to request access.")

        let plain = try status(Self.none)
        XCTAssertNil(plain.policyFailure)
        XCTAssertEqual(plain.failureText("default"), "default")
        XCTAssertTrue(ProviderSubscriptionPromptCard.explanation(try XCTUnwrap(SubscriptionAttention.next(previous: nil, status: plain))).contains("Contact your administrator"))
    }

    func testNoSubscriptionNamesTheProviderAndLooksUpAgain() async throws {
        caller.answer(.providerRefreshSubscription, with: .success(result(Self.none)))
        let model = SubscriptionPromptModel(events: ServerAdminEvents())
        model.apply(serverId: "s", status: try status(Self.none), source: "read")
        let prompt = try XCTUnwrap(model.prompt(for: "s"))
        XCTAssertEqual(ProviderSubscriptionPromptCard.title(prompt), "No Corporate Gateway subscription")

        await model.refresh(serverId: "s", client: client)
        XCTAssertEqual(caller.calls.last?.action, "provider.refreshSubscription")
        XCTAssertEqual(model.note, "Looked up again. There is still no subscription.")
        XCTAssertNotNil(model.prompt(for: "s"))
    }

    func testARefusedChoiceKeepsThePromptAndSaysWhy() async throws {
        caller.answer(.providerSelectSubscription, with: .success(result(Self.choosing, ok: false)))
        let model = SubscriptionPromptModel(events: ServerAdminEvents())
        model.apply(serverId: "s", status: try status(Self.choosing), source: "read")
        await model.select(serverId: "s", id: "std", client: client)
        XCTAssertNotNil(model.prompt(for: "s"))
        XCTAssertEqual(model.operationError, "The server could not select the subscription.")
    }

    func testFollowingReadsTheStateThenTracksPushedSnapshots() async throws {
        caller.answer(.providerSubscription, with: .success(result(#"{"state":"resolving","provider":"gateway"}"#)))
        let events = ServerAdminEvents()
        let model = SubscriptionPromptModel(events: events)
        let task = Task { await model.follow(serverId: "s", client: client) }
        defer { task.cancel() }
        await waitUntil("state read") { self.caller.calls.contains { $0.action == "provider.subscription" } }
        XCTAssertNil(model.prompt(for: "s"))

        events.publish(ServerAdminEvent(serverId: "s", channel: ServerAdminEvent.providerSubscriptionChanged, payload: IntegrationsFixtures.json(Self.none)))
        await waitUntil("prompt shown") { await MainActor.run { model.prompt(for: "s")?.state == "none" } }
    }
}

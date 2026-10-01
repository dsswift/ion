import Foundation
import Observation

/// Which server has a Provider Subscription that needs a person, for the
/// Provider Subscription Prompt.
///
/// `follow` loads a server's state, then replaces it with every
/// `ion:provider-subscription-changed` snapshot. A dismissal is kept while
/// the server stays in the same state, across reconnects too, so the prompt
/// shows once per transition into a state.
@MainActor
@Observable
final class SubscriptionPromptModel {

    private(set) var attention: [String: SubscriptionAttention] = [:]
    private(set) var busy = false
    /// Why the last verb failed, in plain words.
    private(set) var operationError: String?
    /// What the last Look Up Again found, when the state did not change.
    private(set) var note: String?

    @ObservationIgnored private let events: ServerAdminEvents

    init(events: ServerAdminEvents = .shared) {
        self.events = events
    }

    /// The prompt to show for `serverId` now, or nil.
    func prompt(for serverId: String) -> SubscriptionAttention? {
        guard let current = attention[serverId], !current.dismissed else { return nil }
        return current
    }

    func follow(serverId: String, client: ServerAdminClient) async {
        let stream = events.events(for: serverId)
        do {
            let result = try await client.providerSubscription()
            apply(serverId: serverId, status: result.subscription, source: "read")
        } catch is CancellationError {
            return
        } catch {
            DiagnosticLog.log("subscription prompt: state read failed", tag: "admin.subscription", level: .warn, fields: [
                "server_id": serverId, "error": error.localizedDescription
            ])
        }
        for await event in stream where event.channel == ServerAdminEvent.providerSubscriptionChanged {
            do {
                apply(serverId: serverId, status: try event.payload.decoded(as: ProviderSubscriptionStatus.self), source: "push")
            } catch {
                DiagnosticLog.log("subscription prompt: snapshot did not decode", tag: "admin.subscription", level: .warn, fields: [
                    "server_id": serverId, "error": String(String(describing: error).prefix(300))
                ])
            }
        }
    }

    /// Replaces one server's state with a snapshot.
    func apply(serverId: String, status: ProviderSubscriptionStatus, source: String) {
        let previous = attention[serverId]
        let next = SubscriptionAttention.next(previous: previous, status: status)
        attention[serverId] = next
        guard previous?.state != next?.state else { return }
        operationError = nil
        note = nil
        DiagnosticLog.log("subscription prompt: attention state changed", tag: "admin.subscription", fields: [
            "server_id": serverId, "source": source, "state": status.state, "from": previous?.state ?? "", "to": next?.state ?? ""
        ])
    }

    /// Hides the prompt for the state this server is in now.
    func dismiss(serverId: String) {
        guard var current = attention[serverId], !current.dismissed else { return }
        current.dismissed = true
        attention[serverId] = current
        DiagnosticLog.log("subscription prompt: dismissed", tag: "admin.subscription", fields: [
            "server_id": serverId, "state": current.state
        ])
    }

    func select(serverId: String, id: String, client: ServerAdminClient) async {
        await run("select", serverId: serverId) { try await client.selectProviderSubscription(id: id) }
    }

    func refresh(serverId: String, client: ServerAdminClient) async {
        let before = attention[serverId]?.state
        await run("refresh", serverId: serverId) { try await client.refreshProviderSubscription() }
        guard operationError == nil, let after = attention[serverId]?.state, after == before else { return }
        note = after == ProviderSubscriptionStatus.State.none
            ? "Looked up again. There is still no subscription."
            : "Looked up again. Choose a subscription."
    }

    private func run(_ verb: String, serverId: String, _ action: () async throws -> ProviderSubscriptionResult) async {
        busy = true
        operationError = nil
        note = nil
        defer { busy = false }
        do {
            let result = try await action()
            apply(serverId: serverId, status: result.subscription, source: "action")
            if !result.ok {
                operationError = result.error ?? "The server could not \(verb) the subscription."
            }
            DiagnosticLog.log("subscription prompt: action settled", tag: "admin.subscription", level: result.ok ? .info : .warn, fields: [
                "server_id": serverId, "action": verb, "state": result.subscription.state, "error": result.error ?? ""
            ])
        } catch {
            operationError = error.localizedDescription
            DiagnosticLog.log("subscription prompt: action failed", tag: "admin.subscription", level: .warn, fields: [
                "server_id": serverId, "action": verb, "error": error.localizedDescription
            ])
        }
    }
}

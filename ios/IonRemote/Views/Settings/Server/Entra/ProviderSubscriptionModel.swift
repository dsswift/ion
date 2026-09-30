import Foundation
import Observation

/// The provider subscription one server's engine looked up for its signed-in
/// identity, and the two verbs on it: choose one of several, look up again.
///
/// `follow()` loads the state, then replaces it with every
/// `ion:provider-subscription-changed` snapshot, which the server sends on
/// each change from any client.
@MainActor
@Observable
final class ProviderSubscriptionModel {

    let serverId: String
    /// Nil until the first read lands.
    private(set) var status: ProviderSubscriptionStatus?
    private(set) var busy = false
    /// Why the last verb failed, in plain words.
    var operationError: String?

    @ObservationIgnored private let client: ServerAdminClient
    @ObservationIgnored private let events: ServerAdminEvents

    init(serverId: String, client: ServerAdminClient, events: ServerAdminEvents = .shared) {
        self.serverId = serverId
        self.client = client
        self.events = events
    }

    convenience init(session: ServerAdminSession) {
        self.init(serverId: session.serverId, client: session.client)
    }

    func follow() async {
        let stream = events.events(for: serverId)
        await load()
        for await event in stream where event.channel == ServerAdminEvent.providerSubscriptionChanged {
            apply(event.payload)
        }
    }

    func load() async {
        do {
            let result = try await client.providerSubscription()
            status = result.subscription
            DiagnosticLog.log("subscription: state read", tag: "admin.subscription", level: .debug, fields: [
                "server_id": serverId, "state": result.subscription.state
            ])
        } catch is CancellationError {
            return
        } catch {
            DiagnosticLog.log("subscription: state read failed", tag: "admin.subscription", level: .warn, fields: [
                "server_id": serverId, "error": error.localizedDescription
            ])
        }
    }

    /// A snapshot replaces the state, never merges.
    func apply(_ payload: JSONValue) {
        do {
            let snapshot = try payload.decoded(as: ProviderSubscriptionStatus.self)
            status = snapshot
            DiagnosticLog.log("subscription: snapshot applied", tag: "admin.subscription", level: .debug, fields: [
                "server_id": serverId, "state": snapshot.state
            ])
        } catch {
            DiagnosticLog.log("subscription: snapshot did not decode", tag: "admin.subscription", level: .warn, fields: [
                "server_id": serverId, "error": String(String(describing: error).prefix(300))
            ])
        }
    }

    func select(id: String) async {
        await run("select") { try await self.client.selectProviderSubscription(id: id) }
    }

    func refresh() async {
        await run("refresh") { try await self.client.refreshProviderSubscription() }
    }

    private func run(_ verb: String, _ action: () async throws -> ProviderSubscriptionResult) async {
        busy = true
        operationError = nil
        defer { busy = false }
        do {
            let result = try await action()
            status = result.subscription
            if !result.ok {
                operationError = result.error ?? "The server could not \(verb) the subscription."
            }
            DiagnosticLog.log("subscription: action settled", tag: "admin.subscription", level: result.ok ? .info : .warn, fields: [
                "server_id": serverId, "action": verb, "state": result.subscription.state, "error": result.error ?? ""
            ])
        } catch {
            operationError = error.localizedDescription
            DiagnosticLog.log("subscription: action failed", tag: "admin.subscription", level: .warn, fields: [
                "server_id": serverId, "action": verb, "error": error.localizedDescription
            ])
        }
    }
}

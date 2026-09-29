import Foundation
import Observation

/// One server's model providers and models, for the Providers section and
/// each provider's screen. Loads `model.list` and the server's provider
/// policy; reloads when a sign-in finishes.
@MainActor
@Observable
final class ProvidersAdminModel {

    private(set) var catalog: ServerModelCatalog?
    private(set) var policy: ServerModelPolicy = .none
    private(set) var loading = false
    private(set) var error: String?

    @ObservationIgnored let client: ServerAdminClient
    @ObservationIgnored let serverId: String
    @ObservationIgnored private let events: ServerAdminEvents

    init(client: ServerAdminClient, serverId: String, events: ServerAdminEvents = .shared) {
        self.client = client
        self.serverId = serverId
        self.events = events
    }

    /// The providers the server's policy permits, signed-in ones first.
    var providers: [ServerProviderEntry] {
        let shown = (catalog?.providers ?? []).filter { policy.allowsProvider($0.id) }
        return shown.filter(\.hasAuth) + shown.filter { !$0.hasAuth }
    }

    func provider(_ id: String) -> ServerProviderEntry? {
        catalog?.providers.first { $0.id == id }
    }

    func modelCount(for providerId: String) -> Int {
        catalog?.models.filter { $0.providerId == providerId }.count ?? 0
    }

    func load() async {
        loading = true
        defer { loading = false }
        do {
            async let catalog = client.modelCatalog()
            async let policy = loadPolicy()
            let (loaded, narrowed) = try await (catalog, policy)
            self.catalog = loaded
            self.policy = narrowed
            error = nil
            DiagnosticLog.log("providers: catalog loaded", tag: "admin.providers", level: .debug, fields: [
                "server_id": serverId, "providers": String(loaded.providers.count), "models": String(loaded.models.count)
            ])
        } catch is CancellationError {
            return
        } catch {
            self.error = error.localizedDescription
            DiagnosticLog.log("providers: catalog load failed", tag: "admin.providers", level: .warn, fields: [
                "server_id": serverId, "error": String(describing: error)
            ])
        }
    }

    /// Loads, then reloads each time a sign-in finishes, until the caller's task ends.
    func follow() async {
        let stream = events.events(for: serverId)
        await load()
        for await event in stream where event.channel == ServerAdminEvent.providerLoginEvent {
            if event.payload["stage"]?.stringValue == ProviderLoginUpdate.Stage.completed.rawValue {
                await load()
            }
        }
    }

    /// The policy narrows the list; a server that cannot answer it is shown unnarrowed.
    private func loadPolicy() async -> ServerModelPolicy {
        do {
            return try await client.modelPolicy()
        } catch {
            DiagnosticLog.log("providers: policy read failed, showing every provider", tag: "admin.providers", level: .warn, fields: [
                "server_id": serverId, "error": String(describing: error)
            ])
            return .none
        }
    }
}

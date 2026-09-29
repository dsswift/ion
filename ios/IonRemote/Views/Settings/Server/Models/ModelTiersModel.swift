import Foundation
import Observation

/// How one server's engine routes models: its default provider and its
/// model tiers. The engine's snapshots keep both current while a screen follows.
@MainActor
@Observable
final class ModelTiersModel {

    /// Nil until the first load lands.
    private(set) var tiers: [ModelTier]?
    private(set) var defaultProvider: String?
    private(set) var catalog: ServerModelCatalog = .empty
    private(set) var loading = false
    private(set) var busy = false
    /// The last failure, in plain words.
    var error: String?

    @ObservationIgnored private let client: ServerAdminClient
    @ObservationIgnored private let serverId: String
    @ObservationIgnored private let events: ServerAdminEvents

    init(client: ServerAdminClient, serverId: String, events: ServerAdminEvents = .shared) {
        self.client = client
        self.serverId = serverId
        self.events = events
    }

    /// Built-in tiers first, configured or not, then the custom ones.
    var orderedTiers: [ModelTier] {
        let all = tiers ?? []
        let builtIn = ModelTier.builtInNames.map { name in
            all.first { $0.name == name } ?? ModelTier(name: name, model: "", fallbacks: [])
        }
        return builtIn + all.filter { !$0.isBuiltIn }.sorted { $0.name < $1.name }
    }

    func tier(named name: String) -> ModelTier? { orderedTiers.first { $0.name == name } }

    /// The picker's models for a tier whose saved values are `configured`.
    func choices(configured: [String]) -> [ModelChoiceGroup] {
        ModelChoiceGroup.build(models: catalog.models, providers: catalog.providers, configured: configured)
    }

    /// The signed-in providers, plus a saved default that is not, marked so.
    var defaultProviderChoices: [(id: String, label: String)] {
        let signedIn = catalog.providers.filter(\.hasAuth).map { ($0.id, $0.label) }
        guard let saved = defaultProvider, !saved.isEmpty, !signedIn.contains(where: { $0.0 == saved }) else { return signedIn }
        return signedIn + [(saved, "\(ServerProviderEntry.displayName(for: saved, in: catalog.providers)) (unavailable)")]
    }

    func providerLabel(_ id: String) -> String {
        id.isEmpty ? "No preference" : ServerProviderEntry.displayName(for: id, in: catalog.providers)
    }

    /// Reloads, then applies the engine's snapshots until the caller's task ends.
    func follow() async {
        let stream = events.events(for: serverId)
        await load()
        for await event in stream {
            apply(event)
        }
    }

    func load() async {
        loading = true
        defer { loading = false }
        do {
            async let tiers = client.modelTiers()
            async let provider = client.defaultProvider()
            async let catalog = client.modelCatalog()
            let (loadedTiers, loadedProvider, loadedCatalog) = try await (tiers, provider, catalog)
            self.tiers = loadedTiers
            defaultProvider = loadedProvider
            self.catalog = loadedCatalog
            error = nil
            DiagnosticLog.log("model tiers: loaded", tag: "admin.models", level: .debug, fields: [
                "server_id": serverId, "tiers": String(loadedTiers.count), "default_provider": loadedProvider
            ])
        } catch is CancellationError {
            return
        } catch {
            self.error = error.localizedDescription
            DiagnosticLog.log("model tiers: load failed", tag: "admin.models", level: .warn, fields: [
                "server_id": serverId, "error": String(describing: error)
            ])
        }
    }

    /// Applies a pushed snapshot. The engine sends one after every read and
    /// write, so re-reading here would never stop.
    func apply(_ event: ServerAdminEvent) {
        switch event.channel {
        case ServerAdminEvent.modelTiersUpdated:
            guard let value = event.payload["modelTiers"] else {
                DiagnosticLog.log("model tiers: snapshot without tiers, ignored", tag: "admin.models", level: .warn, fields: ["server_id": serverId])
                return
            }
            do {
                tiers = try value.decoded(as: [ModelTier].self)
            } catch {
                DiagnosticLog.log("model tiers: snapshot did not decode, ignored", tag: "admin.models", level: .warn, fields: [
                    "server_id": serverId, "error": String(describing: error)
                ])
            }
        case ServerAdminEvent.defaultProviderUpdated:
            guard let provider = event.payload["defaultProvider"]?.stringValue else {
                DiagnosticLog.log("default provider: snapshot without a provider, ignored", tag: "admin.models", level: .warn, fields: ["server_id": serverId])
                return
            }
            defaultProvider = provider
        default:
            return
        }
    }

    // MARK: - Writes

    @discardableResult
    func save(_ tier: ModelTier) async -> Bool {
        let done = await run("tier save", tier: tier.name) { try await self.client.setModelTier(tier) }
        if done { replace(tier) }
        return done
    }

    func setPrimary(_ tier: ModelTier, model: String) async {
        guard !model.isEmpty else { return }
        await save(ModelTier(name: tier.name, model: model, fallbacks: tier.fallbacks))
    }

    /// This screen owns only the first fallback; the rest of the chain is kept as it is.
    func setFallback(_ tier: ModelTier, model: String) async {
        let rest = Array(tier.fallbacks.dropFirst())
        await save(ModelTier(name: tier.name, model: tier.model, fallbacks: model.isEmpty ? rest : [model] + rest))
    }

    func remove(_ name: String) async {
        let done = await run("tier remove", tier: name) { try await self.client.removeModelTier(name: name) }
        if done { tiers?.removeAll { $0.name == name } }
    }

    func setDefaultProvider(_ provider: String) async {
        let previous = defaultProvider
        defaultProvider = provider
        let done = await run("default provider save", tier: "") { try await self.client.setDefaultProvider(provider) }
        if !done { defaultProvider = previous }
    }

    /// Why `name` cannot be a new tier's name, or nil when it can.
    func nameProblem(_ name: String) -> String? {
        let normalized = name.trimmingCharacters(in: .whitespaces).lowercased()
        if normalized.isEmpty { return nil }
        if ModelTier.builtInNames.contains(normalized) { return "Built-in tier names are reserved." }
        if tiers?.contains(where: { $0.name == normalized }) == true { return "A tier with that name already exists." }
        return nil
    }

    private func replace(_ tier: ModelTier) {
        var next = (tiers ?? []).filter { $0.name != tier.name }
        next.append(tier)
        tiers = next.sorted { $0.name < $1.name }
    }

    private func run(_ verb: String, tier: String, _ body: @escaping @MainActor () async throws -> Void) async -> Bool {
        busy = true
        defer { busy = false }
        do {
            try await body()
            error = nil
            DiagnosticLog.log("model tiers: write done", tag: "admin.models", fields: ["server_id": serverId, "verb": verb, "tier": tier])
            return true
        } catch {
            self.error = error.localizedDescription
            DiagnosticLog.log("model tiers: write failed", tag: "admin.models", level: .warn, fields: [
                "server_id": serverId, "verb": verb, "tier": tier, "error": String(describing: error)
            ])
            return false
        }
    }
}

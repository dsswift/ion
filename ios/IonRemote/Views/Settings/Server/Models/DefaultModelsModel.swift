import Foundation
import Observation

/// Your default models on one server: the model new conversations start on,
/// and the one engine-hosted conversations start on. Both are Account
/// settings there, read with `settings.load` and saved with `settings.save`,
/// and only a model that server offers and permits can be picked.
@MainActor
@Observable
final class DefaultModelsModel {

    /// Nil until the first load lands.
    private(set) var preferredModel: String?
    private(set) var engineDefaultModel: String?
    private(set) var catalog: ServerModelCatalog?
    private(set) var policy: ServerModelPolicy = .none
    private(set) var loading = false
    private(set) var error: String?

    @ObservationIgnored private let client: ServerAdminClient
    @ObservationIgnored private let serverId: String

    init(client: ServerAdminClient, serverId: String) {
        self.client = client
        self.serverId = serverId
    }

    var loaded: Bool { preferredModel != nil && catalog != nil }

    /// The models a default may be: a signed-in provider's, permitted by the
    /// server's policy, shaped for the phone's model picker.
    var pickerModels: [RemoteModelEntry] {
        guard let catalog else { return [] }
        let signedIn = Set(catalog.providers.filter(\.hasAuth).map(\.id))
        return catalog.models
            .filter { signedIn.contains($0.providerId) && policy.allowsModel($0.id) }
            .map { model in
                RemoteModelEntry(
                    id: model.id, providerId: model.providerId, label: model.label,
                    contextWindow: model.contextWindow ?? 0, hasAuth: true,
                    providerLabel: ServerProviderEntry.displayName(for: model.providerId, in: catalog.providers)
                )
            }
    }

    /// A model's name, or its id marked as missing when this server does not offer it.
    func label(for modelId: String) -> String {
        if modelId.isEmpty { return "Not set" }
        if let model = catalog?.models.first(where: { $0.id == modelId }) { return model.label }
        return "\(modelId) (not on this server)"
    }

    func load() async {
        loading = true
        defer { loading = false }
        do {
            async let settings = client.loadSettings()
            async let catalog = client.modelCatalog()
            let (loadedSettings, loadedCatalog) = try await (settings, catalog)
            preferredModel = loadedSettings["preferredModel"]?.stringValue ?? ""
            engineDefaultModel = loadedSettings["engineDefaultModel"]?.stringValue ?? ""
            self.catalog = loadedCatalog
            policy = await loadPolicy()
            error = nil
        } catch is CancellationError {
            return
        } catch {
            self.error = error.localizedDescription
            DiagnosticLog.log("default models: load failed", tag: "admin.models", level: .warn, fields: [
                "server_id": serverId, "error": String(describing: error)
            ])
        }
    }

    func setPreferredModel(_ modelId: String) async {
        let previous = preferredModel
        preferredModel = modelId
        if await !save("preferredModel", modelId) { preferredModel = previous }
    }

    /// Empty follows the conversation model.
    func setEngineDefaultModel(_ modelId: String) async {
        let previous = engineDefaultModel
        engineDefaultModel = modelId
        if await !save("engineDefaultModel", modelId) { engineDefaultModel = previous }
    }

    private func save(_ key: String, _ modelId: String) async -> Bool {
        do {
            try await client.saveSettings([key: .string(modelId)])
            error = nil
            DiagnosticLog.log("default models: saved", tag: "admin.models", fields: [
                "server_id": serverId, "key": key, "model": modelId
            ])
            return true
        } catch {
            self.error = error.localizedDescription
            DiagnosticLog.log("default models: save failed", tag: "admin.models", level: .warn, fields: [
                "server_id": serverId, "key": key, "error": String(describing: error)
            ])
            return false
        }
    }

    private func loadPolicy() async -> ServerModelPolicy {
        do {
            return try await client.modelPolicy()
        } catch {
            DiagnosticLog.log("default models: policy read failed, offering every model", tag: "admin.models", level: .warn, fields: [
                "server_id": serverId, "error": String(describing: error)
            ])
            return .none
        }
    }
}

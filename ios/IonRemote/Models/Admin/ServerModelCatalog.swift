import Foundation

/// A server's models and providers, as `model.list` answers. Mirrors
/// `ModelsListResponse` in `@ion/shared/types-models`.
struct ServerModelCatalog: Decodable, Equatable, Sendable {
    let models: [ServerModelEntry]
    let providers: [ServerProviderEntry]

    static let empty = ServerModelCatalog(models: [], providers: [])

    init(models: [ServerModelEntry], providers: [ServerProviderEntry]) {
        self.models = models
        self.providers = providers
    }

    private enum CodingKeys: String, CodingKey { case models, providers }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // The engine omits an empty list rather than sending [].
        models = try container.decodeIfPresent([ServerModelEntry].self, forKey: .models) ?? []
        providers = try container.decodeIfPresent([ServerProviderEntry].self, forKey: .providers) ?? []
    }
}

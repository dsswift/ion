import Foundation

/// The server's models, model tiers, default provider, and model policy.
extension ServerAdminClient {

    func modelCatalog() async throws -> ServerModelCatalog {
        try await call(.modelList)
    }

    /// The engine's model policy, or `.none` when the server has no enterprise policy.
    func modelPolicy() async throws -> ServerModelPolicy {
        let policy: ServerModelPolicy? = try await call(.policyGetFull)
        return policy ?? .none
    }

    func modelTiers() async throws -> [ModelTier] {
        try await call(.modelListTiers)
    }

    func setModelTier(_ tier: ModelTier) async throws {
        try await callChecked(.modelSetTier, args: [try JSONValue.encoding(tier)])
    }

    func removeModelTier(name: String) async throws {
        try await callChecked(.modelRemoveTier, args: [.object(["name": .string(name)])])
    }

    /// The provider a bare model name resolves to; empty for no preference.
    func defaultProvider() async throws -> String {
        try await call(.providerGetDefault)
    }

    /// Empty clears the preference.
    func setDefaultProvider(_ provider: String) async throws {
        try await callChecked(.providerSetDefault, args: [.object(["provider": .string(provider)])])
    }

    /// Re-fetches the models of one provider, or of every provider for nil.
    func refreshModels(provider: String?) async throws {
        try await callChecked(.modelRefresh, args: [.object(provider.map { ["provider": .string($0)] } ?? [:])])
    }

    /// Runs a write that answers `{ ok, error? }` and throws its error when `ok` is false.
    func callChecked(_ action: PhoneAction, args: [JSONValue], timeoutSeconds: Double? = nil) async throws {
        let result: ProviderActionResult = try await call(action, args: args, timeoutSeconds: timeoutSeconds)
        guard result.ok else {
            throw StudioActionFailure.failed(code: "declined", message: result.error ?? "\(serverLabel) could not complete \(action.rawValue).")
        }
    }
}

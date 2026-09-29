import Foundation

/// The parts of a server's enterprise policy that narrow its providers and
/// models, from `policy.getFull`. Mirrors `EnterprisePolicy` in
/// `@ion/shared/types-enterprise`; the engine enforces it, this only keeps
/// the pickers from offering what the engine would refuse.
struct ServerModelPolicy: Decodable, Equatable, Sendable {
    let allowedProviders: [String]?
    let allowedModels: [String]?
    let blockedModels: [String]?

    static let none = ServerModelPolicy(allowedProviders: nil, allowedModels: nil, blockedModels: nil)

    /// A blocked model is refused even when also allowed; an empty allowlist allows the rest.
    func allowsModel(_ id: String) -> Bool {
        if blockedModels?.contains(id) == true { return false }
        if let allowedModels, !allowedModels.isEmpty, !allowedModels.contains(id) { return false }
        return true
    }

    /// An empty or absent allowlist allows every provider.
    func allowsProvider(_ id: String) -> Bool {
        guard let allowedProviders, !allowedProviders.isEmpty else { return true }
        return allowedProviders.contains(id)
    }
}

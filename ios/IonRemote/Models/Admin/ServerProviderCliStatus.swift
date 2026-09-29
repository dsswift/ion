import Foundation

/// Install and sign-in state of a provider's delegated CLI on the server's
/// host. Mirrors `ProviderCliStatus` in `@ion/shared/types-models`.
struct ServerProviderCliStatus: Decodable, Equatable, Sendable {
    let backend: String
    let installed: Bool
    let version: String?
    let authenticated: Bool
    let email: String?
    /// The CLI's own name for the account ("ChatGPT Pro").
    let label: String?
}

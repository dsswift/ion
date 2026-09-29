import Foundation

/// How a relay says it authenticates (`GET /v1/auth/config`), as
/// `remote.relayAuthConfig` answers it. Nil from the server means the relay
/// did not answer the probe.
struct RelayAuthConfig: Decodable, Equatable, Sendable {
    /// True when the relay requires a Microsoft Entra (OIDC) token.
    let oidc: Bool
    /// True when the relay accepts a shared key.
    let psk: Bool
    /// The primary issuer; empty on a shared-key relay.
    let issuer: String
    let audience: String
    let requiredScope: String

    /// What the relay takes, in words.
    var modeName: String { oidc ? "Microsoft Entra sign-in" : "Shared key" }
}

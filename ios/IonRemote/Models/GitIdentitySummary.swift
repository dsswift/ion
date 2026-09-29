import Foundation

/// FR-04: one git credential a person has configured for a host, redacted --
/// never the raw private key or token. Mirrors
/// `@ion/shared/types-git-identity.ts`'s `GitIdentitySummary`. Arrives as the
/// result of the `gitIdentity.list` action the Git access settings page calls.
struct GitIdentitySummary: Codable, Equatable, Sendable, Identifiable {
    enum Source: String, Codable, Sendable {
        case admin
        case exchangeAdo = "exchange-ado"
        case exchangeGitlab = "exchange-gitlab"
        case exchangeGithub = "exchange-github"
        case user
    }

    enum Kind: String, Codable, Sendable {
        case ssh
        case httpsToken = "https-token"
    }

    let host: String
    let source: Source
    let kind: Kind
    let publicKey: String?
    let username: String?

    /// `host` is unique per snapshot (the resolver keys credentials by
    /// (subject, host) and this projection is always for one subject), so
    /// it doubles as a stable `Identifiable` id for `ForEach`.
    var id: String { host }
}

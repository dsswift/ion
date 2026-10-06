import Foundation

/// FR-04: one git credential a person has for a host, redacted --
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
        /// The host user's own git access, which Ion reads and never stores.
        case host
    }

    /// A git-host CLI whose sign-in the server can use.
    enum Tool: String, Codable, Sendable {
        case gh, glab, az
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
    /// `host` ssh keys only: the public key's file name in `~/.ssh`.
    let file: String?
    /// `host` tokens only: the CLI that is signed in.
    let tool: Tool?

    init(host: String, source: Source, kind: Kind, publicKey: String? = nil, username: String? = nil, file: String? = nil, tool: Tool? = nil) {
        self.host = host
        self.source = source
        self.kind = kind
        self.publicKey = publicKey
        self.username = username
        self.file = file
        self.tool = tool
    }

    /// One host can carry several `host` rows (two ssh keys, a key and a CLI
    /// sign-in), so the key file or tool tells them apart.
    var id: String { "\(source.rawValue)|\(host)|\(file ?? tool?.rawValue ?? "")" }

    /// `*` is a host ssh key that ssh offers to every git host.
    var hostLabel: String { host == "*" ? "Every host" : host }
}

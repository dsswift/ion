import Foundation

/// The words a git credential row uses for its kind and where it came from.
enum GitIdentityLabels {
    static func kind(_ kind: GitIdentitySummary.Kind) -> String {
        switch kind {
        case .ssh: return "SSH key"
        case .httpsToken: return "Token"
        }
    }

    static func source(_ identity: GitIdentitySummary, serverLabel: String) -> String {
        switch identity.source {
        case .admin: return "Managed by your organization"
        case .exchangeAdo: return "Via Azure DevOps"
        case .exchangeGitlab: return "Via GitLab"
        case .exchangeGithub: return "Via GitHub"
        case .user: return "Set by you"
        case .host:
            if let tool = identity.tool {
                guard let username = identity.username, !username.isEmpty else { return "Signed in with \(tool.rawValue)" }
                return "Signed in with \(tool.rawValue) as \(username)"
            }
            return "\(identity.file ?? "ssh key") in ~/.ssh on \(serverLabel)"
        }
    }

    /// Only a credential this person holds on the server can be removed from
    /// here; an operator-managed one lives in the server's config, and a
    /// host one belongs to the host user's own setup.
    static func isRemovable(_ identity: GitIdentitySummary) -> Bool { identity.source != .admin && identity.source != .host }
}

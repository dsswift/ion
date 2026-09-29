import Foundation

/// The words a git credential row uses for its kind and where it came from.
enum GitIdentityLabels {
    static func kind(_ kind: GitIdentitySummary.Kind) -> String {
        switch kind {
        case .ssh: return "SSH key"
        case .httpsToken: return "Token"
        }
    }

    static func source(_ source: GitIdentitySummary.Source) -> String {
        switch source {
        case .admin: return "Managed by your organization"
        case .exchangeAdo: return "Via Azure DevOps"
        case .exchangeGitlab: return "Via GitLab"
        case .exchangeGithub: return "Via GitHub"
        case .user: return "Set by you"
        }
    }

    /// Only a credential this person holds on the server can be removed from
    /// here; an operator-managed one lives in the server's config.
    static func isRemovable(_ identity: GitIdentitySummary) -> Bool { identity.source != .admin }
}

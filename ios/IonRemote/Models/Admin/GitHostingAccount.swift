import Foundation

/// `gitHosting.accounts`: one git host a server holds a token for, and who
/// that token acts as. Mirrors `GitHostingAccount` in
/// `@ion/shared/types-git-hosting`.
struct GitHostingAccount: Decodable, Equatable, Sendable, Identifiable {
    enum Provider: String, Decodable, Sendable {
        case github, gitlab
        case azureDevops = "azure-devops"

        /// What this host calls the place a repository is created in.
        var ownerTitle: String {
            switch self {
            case .github: return "Owner"
            case .gitlab: return "Namespace"
            case .azureDevops: return "Project"
            }
        }
    }

    let host: String
    let provider: Provider
    /// The account name on the host; empty when the host refused to say.
    let account: String
    let credentialSource: GitIdentitySummary.Source
    let owners: [GitHostingOwner]
    /// False where a repository takes its visibility from its owner.
    let choosesVisibility: Bool
    /// The host's own words when it refused the account or owner listing.
    let error: String?

    var id: String { "\(host)|\(account)" }
    var title: String { account.isEmpty ? host : "\(host) · \(account)" }
}

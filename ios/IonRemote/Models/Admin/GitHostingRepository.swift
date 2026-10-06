import Foundation

/// `gitHosting.createRepository`: the repository a server just created. It
/// has one commit, and two URLs for the cloning server to pick from. Mirrors
/// `GitHostingRepository` in `@ion/shared/types-git-hosting`.
struct GitHostingRepository: Decodable, Equatable, Sendable {
    let host: String
    let provider: GitHostingAccount.Provider
    /// The owner's path on the host (`org`, `group/subgroup`, `org/project`).
    let owner: String
    let name: String
    let webUrl: String
    let sshUrl: String
    let httpsUrl: String
    let defaultBranch: String
}

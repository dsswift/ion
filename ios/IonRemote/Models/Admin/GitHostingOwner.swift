import Foundation

/// Where a new repository can live on a git host: the account itself, or an
/// organization, group, or project it can create in. Mirrors
/// `GitHostingOwner` in `@ion/shared/types-git-hosting`.
struct GitHostingOwner: Decodable, Equatable, Sendable, Identifiable {
    enum Kind: String, Decodable, Sendable {
        case user, org, group, project
    }

    /// Opaque: sent back as the `owner` of a create request.
    let id: String
    let label: String
    let kind: Kind
}

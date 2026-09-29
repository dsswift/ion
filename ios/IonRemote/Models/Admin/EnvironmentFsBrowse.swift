import Foundation

/// `environment.fs.browse`: the folders under one path on the server's host.
/// Mirrors `EnvironmentFsBrowse` in `@ion/shared/types-environment-admin`.
struct EnvironmentFsBrowse: Decodable, Equatable, Sendable {
    struct Entry: Decodable, Equatable, Sendable, Identifiable {
        let name: String
        let fullPath: String
        let isGitRepo: Bool
        var id: String { fullPath }
    }

    /// The absolute path that was listed (`~` resolved to the home folder).
    let path: String
    /// Nil at the filesystem root.
    let parentPath: String?
    let pathIsGitRepo: Bool
    let home: String
    let entries: [Entry]
}

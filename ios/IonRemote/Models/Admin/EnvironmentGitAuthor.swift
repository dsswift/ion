import Foundation

/// `environment.git.author.get` / `.set`: the server host's global git
/// author. Either field is empty when git has none set.
struct EnvironmentGitAuthor: Codable, Equatable, Sendable {
    let name: String
    let email: String

    var isSet: Bool { !name.isEmpty && !email.isEmpty }
}

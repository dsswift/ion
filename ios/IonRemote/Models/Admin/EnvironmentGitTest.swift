import Foundation

/// `environment.git.test`: whether the server reaches one repository URL.
/// Mirrors `EnvironmentGitTest` in `@ion/shared/types-environment-admin`.
struct EnvironmentGitTest: Decodable, Equatable, Sendable, Identifiable {
    let url: String
    let ok: Bool
    /// The remote's HEAD branch when the test succeeded.
    let defaultBranch: String?
    let error: String?
    let durationMs: Double

    var id: String { url }
}

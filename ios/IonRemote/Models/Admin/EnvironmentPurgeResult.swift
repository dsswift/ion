import Foundation

/// `environment.purge.run`: what the uninstall removed. Mirrors
/// `EnvironmentPurgeResult` in `packages/shared/src/types-environment-admin.ts`.
struct EnvironmentPurgeResult: Decodable, Equatable, Sendable {
    let removedClones: [String]
    let keptDirtyClones: [String]
    let removedGitCredentialHosts: [String]
    /// True when the uninstall was scheduled; the server exits shortly after.
    let uninstallScheduled: Bool
    let uninstallError: String?
}

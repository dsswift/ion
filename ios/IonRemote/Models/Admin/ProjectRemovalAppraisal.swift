import Foundation

/// `environment.projects.appraiseRemoval`: what removing a project would
/// touch, which decides the choices the confirmation offers.
struct ProjectRemovalAppraisal: Decodable, Equatable, Sendable {
    let dir: String
    let registered: Bool
    /// Only a checkout Ion cloned may have its files deleted.
    let clonedByIon: Bool
    let exists: Bool
    /// Uncommitted changes in the checkout.
    let dirty: Bool
    /// Live worktrees cut from the checkout.
    let worktrees: Int

    /// Deleting the files would lose work, so the delete needs `force`.
    var isRisky: Bool { dirty || worktrees > 0 }
}

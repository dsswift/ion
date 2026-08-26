import Foundation

/// Desktop-owned New Conversation project projection.
///
/// The desktop snapshot is authoritative. iOS renders these projects and sends
/// the selected directory back in its normal create-tab command.
struct RemoteProject: Codable, Identifiable, Equatable, Sendable {
    var directory: String
    var displayName: String
    var isDefault: Bool
    var managed: Bool
    var profileAction: String
    var profileId: String?
    var profileSource: String?
    var hasOverride: Bool

    var id: String { directory }
}

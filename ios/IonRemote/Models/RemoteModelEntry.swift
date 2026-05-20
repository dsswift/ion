import Foundation

/// Model entry received from the desktop via the snapshot event.
/// Matches the wire shape: `{ id, providerId, label, contextWindow, hasAuth }`.
struct RemoteModelEntry: Codable, Sendable, Identifiable {
    let id: String
    let providerId: String
    let label: String
    let contextWindow: Int
    let hasAuth: Bool
}

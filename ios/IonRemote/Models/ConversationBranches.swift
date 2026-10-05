import Foundation

/// The engine's `list_branches` answer, relayed by the server's
/// `engine.listBranches`: every root-to-leaf path of a conversation tree.
/// Mirrors `packages/shared/src/conversation-branches.ts`.
struct ConversationBranches: Codable, Sendable, Equatable {
    /// The current leaf. Interior right after a rewind; empty when cleared to the start.
    let activeLeafId: String
    let branches: [ConversationBranch]
}

/// One root-to-leaf path.
struct ConversationBranch: Codable, Sendable, Equatable, Identifiable {
    let leafId: String
    /// The leaf entry's timestamp, Unix ms.
    let timestamp: Double
    /// Text of the path's last message that has any, cut short.
    let preview: String
    let messageCount: Int
    let forkPointId: String?
    let active: Bool

    var id: String { leafId }
}

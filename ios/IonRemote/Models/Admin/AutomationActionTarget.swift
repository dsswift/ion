import Foundation

/// What an action points at. `directory` is a worktree or a fixed path.
enum AutomationActionTarget: String, Codable, Sendable {
    case none, worktree, conversation, directory
}

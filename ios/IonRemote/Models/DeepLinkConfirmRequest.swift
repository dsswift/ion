import Foundation

/// An `ion://` action link waiting for the person's decision. Carries the
/// exact command or prompt that would run, so the confirmation shows it in
/// full. Mirrors `DeepLinkConfirmRequest` in
/// `packages/shared/src/types-ipc-deeplink.ts`.
struct DeepLinkConfirmRequest: Decodable, Equatable, Sendable {
    let id: String
    let owner: String
    /// "terminal", "prompt", or "ext". Raw so a newer server's action still decodes.
    let action: String
    /// Target conversation id (terminal requests).
    let tabId: String?
    /// Pane label (terminal requests).
    let title: String?
    /// The command that would run (terminal requests).
    let cmd: String?
    /// Working directory.
    let dir: String?
    /// The prompt that would be sent (prompt requests).
    let text: String?
    /// Whether the prompt would be submitted immediately (prompt requests).
    let submit: Bool?
    /// The extension route id (ext requests).
    let routeId: String?
    /// The route's label as its extension registered it (ext requests).
    let label: String?
    /// The slash command that would run, arguments included (ext requests).
    let command: String?
    /// The conversation the command runs in; absent opens a new one in `dir` (ext requests).
    let conversationId: String?
}

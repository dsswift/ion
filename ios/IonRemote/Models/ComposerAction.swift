import Foundation

/// A row an extension adds to the composer's `+` menu through the Studio SDK.
/// Choosing it sends `command` through the normal prompt path. The server
/// decides which actions a conversation offers and sends that list on
/// `RemoteTabState.composerActions`; iOS derives nothing. Mirrors
/// `ComposerAction` in `packages/shared/src/studio-sdk-contract.ts`.
struct ComposerAction: Codable, Equatable, Sendable {
    /// Unique per producer.
    let id: String
    /// The extension that contributed it, assigned by the engine.
    let producer: String
    let label: String
    /// A Phosphor icon name from Studio.
    let icon: String
    /// The slash command sent when the row is chosen.
    let command: String
    /// Set when the action belongs to one conversation only.
    let conversationId: String?

    /// Unique across extensions: `id` is unique only within one producer.
    var menuKey: String { "\(producer):\(id)" }

    /// The menu icon. A name Studio does not know gets the extension icon.
    var systemImage: String { PhosphorSymbol.systemName(for: icon, fallback: "puzzlepiece.extension") }
}

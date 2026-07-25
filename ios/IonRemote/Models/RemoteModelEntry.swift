import Foundation

/// Model entry received from the desktop via the snapshot event.
/// Matches the wire shape: `{ id, providerId, label, contextWindow, hasAuth,
/// thinkingMode?, thinkingEfforts?, modelKind? }`.
struct RemoteModelEntry: Codable, Sendable, Identifiable {
    let id: String
    let providerId: String
    let label: String
    let contextWindow: Int
    let hasAuth: Bool
    /// Reasoning mechanism the model uses ("adaptive" | "budget" |
    /// "reasoning_effort" | "gemini" | "none"). Used with thinkingEfforts to
    /// show/gray the per-conversation thinking control. Optional for
    /// back-compat with older desktop snapshots.
    var thinkingMode: String?
    /// Effort levels the model accepts (e.g. ["low","medium","high"]).
    /// Empty/absent ⇒ thinking control hidden for this model.
    var thinkingEfforts: [String]?
    /// API shape this model uses. nil / absent means "chat" (standard
    /// conversational API). "image" means a dedicated image-generation API
    /// (e.g. DALL-E 3, gpt-image-1) — single prompt in, image out with no
    /// conversation history. Optional for back-compat with older desktop
    /// snapshots that predate the modelKind field.
    var modelKind: String?
}

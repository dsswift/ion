import Foundation

/// Model entry received from the desktop via the snapshot event.
/// Matches the wire shape: `{ id, providerId, providerLabel, label,
/// contextWindow, hasAuth, thinkingMode?, thinkingEfforts?, modelKind?,
/// isCustom? }`.
struct RemoteModelEntry: Codable, Sendable, Identifiable, Equatable {
    let id: String
    let providerId: String
    let label: String
    let contextWindow: Int
    let hasAuth: Bool
    /// Human-facing provider name resolved by the desktop at projection time
    /// (operator `engine.json` displayName > built-in name map > capitalized
    /// id). iOS does not receive `ProviderEntry`, so this flattened field is
    /// how the provider-grouped picker gets its section headers. Optional for
    /// back-compat with desktops that predate the field; `ModelPickerGrouping`
    /// falls back to the capitalized `providerId`.
    var providerLabel: String?
    /// Reasoning mechanism the model uses ("adaptive" | "budget" |
    /// "reasoning_effort" | "gemini" | "none"). Used with thinkingEfforts to
    /// resolve the per-conversation thinking control's rendering: "adaptive"
    /// means the model always thinks and cannot be turned off, so its "off" row
    /// reads "Adaptive". Optional for back-compat with older desktop snapshots.
    var thinkingMode: String?
    /// Effort levels the model accepts (e.g. ["low","medium","high"]).
    /// Empty/absent ⇒ no override levels to offer, so the thinking control
    /// renders DISABLED for this model — never hidden.
    var thinkingEfforts: [String]?
    /// API shape this model uses. nil / absent means "chat" (standard
    /// conversational API). "image" means a dedicated image-generation API
    /// (e.g. DALL-E 3, gpt-image-1) — single prompt in, image out with no
    /// conversation history. Optional for back-compat with older desktop
    /// snapshots that predate the modelKind field.
    var modelKind: String?
    /// True for an operator-defined model (engine.json `models` entry) rather
    /// than one the provider's own catalog reported. Drives the `custom` badge
    /// in the picker. Optional for back-compat.
    var isCustom: Bool?
}

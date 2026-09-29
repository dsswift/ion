import Foundation

/// One source definition as the settings list shows it: every layer that
/// defines an id is listed, not only the one that runs.
struct AutomationSourceEntry: Codable, Equatable, Sendable, Identifiable {
    let definition: AutomationDefinition
    let source: AutomationSource
    /// This exact source is the one the server runs for its id.
    let effective: Bool
    /// Project rules only: the id is switched off on this server.
    let locallyDisabled: Bool?
    /// Set on an entry that does not run: the layer that owns the id instead.
    let overriddenBy: AutomationSource?

    var id: String { "\(source.rawValue):\(definition.id)" }
}

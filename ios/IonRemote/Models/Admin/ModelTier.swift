import Foundation

/// One named model tier on a server's engine: its primary model and the
/// fallbacks tried after it. Mirrors `ModelTier` in `@ion/shared/types-model-tiers`.
struct ModelTier: Codable, Equatable, Sendable, Identifiable {
    let name: String
    /// Empty for a built-in tier that has no model yet.
    let model: String
    let fallbacks: [String]

    var id: String { name }

    init(name: String, model: String, fallbacks: [String]) {
        self.name = name
        self.model = model
        self.fallbacks = fallbacks
    }

    private enum CodingKeys: String, CodingKey { case name, model, fallbacks }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        model = try container.decodeIfPresent(String.self, forKey: .model) ?? ""
        // The engine sends null for a tier with no fallbacks.
        fallbacks = try container.decodeIfPresent([String].self, forKey: .fallbacks) ?? []
    }

    /// The tiers every server has, in the order Studio lists them.
    static let builtInNames = ["reasoning", "standard", "fast", "workbench-sync"]
    /// The built-in tier that uses the standard tier when it has no model.
    static let workbenchSync = "workbench-sync"

    var isBuiltIn: Bool { Self.builtInNames.contains(name) }
}

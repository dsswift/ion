import Foundation

/// The answer to `automation.upsert`, `.duplicate`, `.delete`, and
/// `.setProjectEnabled`: a refusal is `ok: false` with its reason.
struct AutomationMutationResult: Codable, Equatable, Sendable {
    let ok: Bool
    let error: String?
    /// The stored definition, from upsert and duplicate.
    let definition: AutomationDefinition?
}

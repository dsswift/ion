import Foundation

/// One fixed AI-assisted workflow and its built-in prompt, as
/// `aiAssist.workflows` answers. Mirrors `AiAssistWorkflow` in
/// `@ion/shared/ai-assist-workflows`.
struct AIWorkflow: Decodable, Equatable, Sendable, Identifiable {
    let id: String
    let label: String
    let description: String
    /// The `{{name}}` placeholders the prompt may use.
    let placeholders: [String]
    let defaultTemplate: String

    /// Why `template` cannot be saved, or nil when it can: it may use only
    /// this workflow's placeholders. The same rule as `validateAiAssistTemplate`.
    func validationError(_ template: String) -> String? {
        let allowed = Set(placeholders)
        var unknown: [String] = []
        for match in template.matches(of: #/\{\{([A-Za-z][A-Za-z0-9]*)\}\}/#) {
            let name = String(match.1)
            if !allowed.contains(name), !unknown.contains(name) { unknown.append(name) }
        }
        guard !unknown.isEmpty else { return nil }
        let list = unknown.map { "{{\($0)}}" }.joined(separator: ", ")
        return "Unknown placeholder\(unknown.count == 1 ? "" : "s"): \(list)"
    }
}

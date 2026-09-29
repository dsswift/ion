import Foundation

/// An action an automation may run, what it targets, and its settings.
struct AutomationActionSpec: Codable, Equatable, Sendable {
    let kind: String
    let label: String
    let target: AutomationActionTarget
    let config: [AutomationActionConfigField]
}

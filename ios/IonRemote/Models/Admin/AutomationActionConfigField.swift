import Foundation

/// One setting of an automation action.
struct AutomationActionConfigField: Codable, Equatable, Sendable {
    let key: String
    let label: String
    let type: AutomationFieldType
    let required: Bool
    let values: [AutomationFieldChoice]?

    init(key: String, label: String, type: AutomationFieldType, required: Bool, values: [AutomationFieldChoice]? = nil) {
        self.key = key
        self.label = label
        self.type = type
        self.required = required
        self.values = values
    }
}

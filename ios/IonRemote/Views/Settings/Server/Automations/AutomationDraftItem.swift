import Foundation

/// A draft the editor sheet opens: a new automation, a template, or a fresh copy.
struct AutomationDraftItem: Identifiable {
    let id = UUID()
    let definition: AutomationDefinition
    let isNew: Bool
}

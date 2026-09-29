import Foundation

/// One allowed value of an enum field, with its label.
struct AutomationFieldChoice: Codable, Equatable, Hashable, Sendable {
    let value: String
    let label: String
}

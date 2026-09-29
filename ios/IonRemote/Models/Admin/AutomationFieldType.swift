import Foundation

/// The kind of value an automation field or action setting holds.
enum AutomationFieldType: String, Codable, Sendable {
    case string, number, boolean
    case enumType = "enum"
    case path
}

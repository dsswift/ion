import Foundation

/// What starts an automation: always an event, by its catalog name.
struct AutomationTrigger: Codable, Equatable, Sendable {
    var kind: String = "event"
    var event: String
}

import Foundation

/// Which layer an automation came from. Only `user` is editable.
enum AutomationSource: String, Codable, Sendable {
    case user, project, enterprise
    case builtIn = "built-in"
}

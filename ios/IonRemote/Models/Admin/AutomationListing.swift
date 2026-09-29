import Foundation

/// The answer to `automation.listing`.
struct AutomationListing: Codable, Equatable, Sendable {
    let entries: [AutomationSourceEntry]
    /// Enterprise policy locks changes; definitions are still listed.
    let locked: Bool
}

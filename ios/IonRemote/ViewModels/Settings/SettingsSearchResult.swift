import Foundation

/// One match of a Settings search: a page, a section, or a setting, and the
/// page to open for it.
struct SettingsSearchResult: Identifiable, Equatable, Sendable {

    enum Destination: Hashable, Sendable {
        /// A page this phone keeps.
        case phone(PhoneSettingsPage)
        /// A page of the connected server.
        case server(pageId: String)
    }

    let id: String
    let title: String
    /// Where it lives: "This iPhone › Behavior", "Studio Mac › Workflow".
    let detail: String
    let destination: Destination
}

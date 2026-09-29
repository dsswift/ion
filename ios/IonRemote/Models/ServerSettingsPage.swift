import Foundation

/// One settings page, as the server lays pages out on
/// `desktop_settings_snapshot.pages`: the same page and section ids, labels,
/// and order the server's settings use.
struct ServerSettingsPage: Codable, Equatable, Sendable, Identifiable {

    /// Which heading a page sits under.
    enum Scope: String, Codable, Sendable {
        /// "This Device".
        case device
        /// "You".
        case you
        /// "Servers".
        case server
        /// A heading this build does not know yet.
        case unknown

        init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Scope(rawValue: raw) ?? .unknown
        }
    }

    /// One section of a page, in render order.
    struct Section: Codable, Equatable, Sendable, Identifiable {
        let id: String
        let label: String
    }

    let id: String
    let label: String
    let scope: Scope
    let sections: [Section]
}

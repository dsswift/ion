import Foundation

/// Whether a server announces itself on its local network, as
/// `environment.discovery.status` and the window verbs answer it.
struct EnvironmentDiscoveryStatus: Decodable, Equatable, Sendable {

    enum Mode: String, Decodable, Sendable {
        /// The organization turned LAN discovery off.
        case sealed
        case off
        /// Discoverable until `until`, then it turns itself off.
        case window
        /// Always discoverable, set in the host's server.json.
        case persistent
    }

    let mode: Mode
    let advertising: Bool
    /// Unix ms a timed window closes itself; nil outside one.
    let until: Double?
    /// The live one-time pairing code, `XXXX-XXXX`. Nil without one, and
    /// always nil for a connection without admin.
    let code: String?

    var untilDate: Date? { until.map { Date(timeIntervalSince1970: $0 / 1000) } }
}

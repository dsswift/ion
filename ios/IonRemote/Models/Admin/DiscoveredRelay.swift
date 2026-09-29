import Foundation

/// A relay the server found on its own network (`remote.discoverRelays`,
/// then `ion:remote-relays-changed`).
struct DiscoveredRelay: Decodable, Equatable, Identifiable, Sendable {
    let id: String
    let name: String
    let host: String
    let port: Int
    let addresses: [String]

    /// The URL to reach it by: its first IPv4 address, else its host name.
    var url: String {
        let address = addresses.first { !$0.contains(":") } ?? host
        return "ws://\(address):\(port)"
    }
}

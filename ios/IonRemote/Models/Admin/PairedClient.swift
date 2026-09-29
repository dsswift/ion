import Foundation

/// One device paired to a server, as `auth.listClients` answers it: the
/// pairing record with its secret and push token removed.
struct PairedClient: Decodable, Equatable, Identifiable, Sendable {

    enum Kind: String, Decodable, Sendable {
        case desktop
        case mobile
    }

    /// The id the server knows this pairing by.
    let clientId: String
    let scopes: [String]
    let subject: String
    /// Unix ms the pairing was made.
    let createdAt: Double
    /// Unix ms the device last connected.
    let lastSeen: Double
    /// Unix ms the pairing was revoked, or nil while it is live.
    let revokedAt: Double?
    let kind: Kind
    /// The label the device gave at pairing. Absent on old records.
    let label: String?
    /// Whether a connection from this device is open now. Absent from a
    /// server that predates it.
    let connected: Bool?

    var id: String { clientId }
    var isAdmin: Bool { scopes.contains(StudioScope.admin.rawValue) }
    var isRevoked: Bool { revokedAt != nil }
    var isConnected: Bool { connected == true }
    /// The name a person reads for this pairing.
    var displayName: String {
        guard let label, !label.trimmingCharacters(in: .whitespaces).isEmpty else { return "Unnamed device" }
        return label
    }
    var pairedDate: Date { Date(timeIntervalSince1970: createdAt / 1000) }
    var lastSeenDate: Date { Date(timeIntervalSince1970: lastSeen / 1000) }
    /// What the kind is called on screen: the wire says mobile, a person says phone.
    var kindName: String { kind == .mobile ? "phone" : "desktop" }
    var symbol: String { kind == .mobile ? "iphone" : "desktopcomputer" }
}

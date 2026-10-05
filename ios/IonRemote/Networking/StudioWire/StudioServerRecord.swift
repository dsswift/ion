import Foundation
import CryptoKit

/// One server this phone is paired with on the Studio wire: the credential
/// (`clientId` plus the shared secret) and how to reach the server.
struct StudioServerRecord: Codable, Equatable, Identifiable, Sendable {
    /// The id the server knows this pairing by. Every hello carries it.
    let clientId: String
    /// The 32-byte shared secret. It seals every frame and keys the hello proof.
    let secret: Data
    /// The server's last known base URL (`http://host:port`). Nil until
    /// discovery finds the server on a network; the relays work without it.
    var url: String?
    /// The server's environment id, learned from a pairing or a welcome.
    var environmentId: String?
    /// The host's machine id, matched against the server's Bonjour announcement.
    var machineId: String?
    var label: String
    /// The relays the server can be reached through, newest welcome wins.
    var relays: [StudioEnvironmentRelay]
    /// Where the server said it answers directly, newest welcome wins: its
    /// addresses, then its `.local` name. Nil in a record stored before the
    /// field existed.
    var directAddresses: [String]?
    /// The `PairedDevice.id` this record was carried over from. The OIDC token
    /// manager for an OIDC relay is kept under that id. Nil for a pairing made
    /// on the Studio wire.
    var pairedDeviceId: String?

    var id: String { clientId }
    var key: SymmetricKey { SymmetricKey(data: secret) }
    var serverURL: URL? { url.flatMap { URL(string: $0) } }

    /// The id a server gives a pairing: the first 16 hex characters of the
    /// channel id derived from the secret.
    static func clientId(forSecret secret: Data) -> String {
        String(E2ECrypto.deriveChannelId(sharedSecret: SymmetricKey(data: secret)).prefix(16))
    }

    /// The record among `records` for a paired device: the one migrated from
    /// it, or the one whose id its secret derives.
    static func record(for device: PairedDevice, in records: [StudioServerRecord]) -> StudioServerRecord? {
        let derived = clientId(forSecret: device.sharedSecret)
        return records.first { $0.pairedDeviceId == device.id } ?? records.first { $0.clientId == derived }
    }
}

/// Where `StudioServerRecord`s are kept. The whole list is one Keychain item,
/// beside the paired-device list, because every record holds a secret.
protocol StudioServerStoring: Sendable {
    func load() throws -> [StudioServerRecord]
    func save(_ records: [StudioServerRecord]) throws
}

struct StudioServerKeychainStore: StudioServerStoring {
    static let keychainKey = "studio-servers"

    func load() throws -> [StudioServerRecord] {
        guard let data = try KeychainStore.load(key: Self.keychainKey) else { return [] }
        return try JSONDecoder().decode([StudioServerRecord].self, from: data)
    }

    func save(_ records: [StudioServerRecord]) throws {
        try KeychainStore.save(key: Self.keychainKey, data: try JSONEncoder().encode(records))
    }
}

import Foundation

// MARK: - FR-02 presence event
//
// Decode/encode for `desktop_presence`. Kept in its own file rather than
// folded into an existing family extension -- presence has no relationship
// to worktrees, git, or any other decoded family.

extension RemoteEvent {

    /// Decode the presence event. Returns nil for anything not owned here, so
    /// the caller can fall through to the other decoders.
    static func decodePresence(
        type: TypeKey,
        container: KeyedDecodingContainer<CodingKeys>
    ) throws -> RemoteEvent? {
        switch type {
        case .presence:
            // Reuses the existing `.entries` CodingKeys case (shared with the
            // file-explorer family's unrelated `entries` field) -- the flat
            // shared CodingKeys enum requires every raw value be unique, and
            // "entries" is already taken, so a second case with the same raw
            // string would fail to compile. Both fields are genuinely named
            // "entries" on the wire, so sharing the key is correct, not a
            // workaround.
            let entries = try container.decode([PresenceEntry].self, forKey: .entries)
            let driving = try container.decode([String: String].self, forKey: .driving)
            return .presence(entries: entries, driving: driving)

        default:
            return nil
        }
    }

    /// Encode the presence event. iOS never sends this, but Codable
    /// conformance requires the path.
    func encodePresence(into container: inout KeyedEncodingContainer<CodingKeys>) throws -> Bool {
        switch self {
        case .presence(let entries, let driving):
            try container.encode(TypeKey.presence, forKey: .type)
            try container.encode(entries, forKey: .entries)
            try container.encode(driving, forKey: .driving)
            return true

        default:
            return false
        }
    }
}

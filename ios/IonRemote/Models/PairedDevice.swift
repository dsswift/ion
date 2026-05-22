import Foundation

/// An Ion instance paired with this iOS device.
/// Mirrors `PairedDevice` in `src/main/remote/protocol.ts`.
///
/// `customName` / `customIcon` / `remoteDisplayUpdatedAt` are server-side
/// authoritative — they are synced from the desktop's `remoteDisplay`
/// settings record via the `remote_display` event (live) or the `snapshot`
/// event (catchup after reconnect). Cached locally in the keychain blob
/// so the picker can render personalized labels immediately on launch,
/// before any sync round-trip completes. Falls back to the OS hostname
/// and a default `desktopcomputer` glyph when unset.
struct PairedDevice: Codable, Identifiable, Sendable {
    let id: String
    let name: String
    let pairedAt: Date
    var lastSeen: Date?
    let channelId: String
    /// 32-byte NaCl secretbox key
    let sharedSecret: Data
    var relayURL: String?
    var relayAPIKey: String?
    var apnsToken: String?

    /// User-supplied override for the desktop's display name. Empty/whitespace
    /// is treated as "no override" and the original `name` (host name) is used.
    var customName: String?

    /// User-supplied icon identifier (one of: "desktop", "laptop", "macmini",
    /// "macpro", "display", "server", "terminal", "briefcase", "house",
    /// "gamepad"). Unknown identifiers degrade to the default desktop icon.
    var customIcon: String?

    /// Last-write-wins timestamp for the override, ms since epoch. Used to
    /// reconcile concurrent edits from multiple phones / the desktop UI.
    var remoteDisplayUpdatedAt: Date?

    // MARK: - Display helpers

    /// Resolved display name: the user override if set + non-blank, else
    /// the original host name discovered during pairing.
    var displayName: String {
        if let custom = customName?.trimmingCharacters(in: .whitespacesAndNewlines),
           !custom.isEmpty {
            return custom
        }
        return name
    }

    /// Resolved SF Symbol name for the picker. Maps the curated identifier
    /// set to concrete SF Symbol names. Unknown identifiers (e.g. forward-
    /// compat additions from a newer desktop) fall back to the default.
    var displayIcon: String {
        guard let identifier = customIcon, !identifier.isEmpty else {
            return Self.defaultIconSymbol
        }
        return Self.iconSymbol(for: identifier)
    }

    static let defaultIconSymbol = "desktopcomputer"

    /// Map a curated icon identifier to an SF Symbol name. Kept in lockstep
    /// with the Phosphor mapping in `RemoteDisplayPanel.tsx` on the desktop
    /// side — both sides must accept the same identifiers.
    static func iconSymbol(for identifier: String) -> String {
        switch identifier {
        case "desktop":   return "desktopcomputer"
        case "laptop":    return "laptopcomputer"
        case "macmini":   return "macmini"
        case "macpro":    return "macpro.gen3"
        case "display":   return "display"
        case "server":    return "server.rack"
        case "terminal":  return "terminal.fill"
        case "briefcase": return "briefcase.fill"
        case "house":     return "house.fill"
        case "gamepad":   return "gamecontroller.fill"
        default:          return defaultIconSymbol
        }
    }
}

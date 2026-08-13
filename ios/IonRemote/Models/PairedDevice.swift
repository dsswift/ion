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

    // MARK: - Enterprise Relay Phase 1 (OIDC)

    /// Auth mode for the relay: `"psk"` (pre-shared key) or `"oidc"`.
    /// Nil for pre-enterprise desktops.
    var relayAuthMode: String?
    /// OIDC issuer URL. Present when `relayAuthMode == "oidc"`.
    var relayOidcIssuer: String?
    /// OIDC audience (app registration client ID).
    var relayOidcAudience: String?
    /// Full OIDC scope string (e.g. `"api://<id>/Relay.Access"`).
    var relayOidcRequiredScope: String?
    /// OAuth2 client ID used by iOS to acquire OIDC tokens independently
    /// (ASWebAuthenticationSession PKCE flow). Nil for PSK-mode and
    /// pre-Phase-2 OIDC devices that pre-date autonomous acquisition.
    var relayOidcClientId: String?

    // MARK: - Per-pairing OIDC account (display only)

    // Which identity this pairing's tokens belong to, so a phone paired with
    // desktops in different tenants can show the user which account each
    // desktop is bound to and explain a relay refusal.
    //
    // Captured on THIS device from the `id_token` in the token-endpoint
    // response; never sent to the desktop and never read by the relay. These
    // are display values only — see `OIDCAccountIdentity`, which documents why
    // parsing without signature verification is safe here. All optional, so
    // existing Keychain blobs written before these fields existed still decode.

    /// UPN / email of the signed-in account (`preferred_username` / `upn` / `email`).
    var relayOidcAccountUsername: String?
    /// Display name of the signed-in account (`name`).
    var relayOidcAccountName: String?
    /// Stable subject identifier (`oid` / `sub`) — what the relay binds a channel to.
    var relayOidcSubject: String?
    /// Tenant identifier (`tid`), distinguishing a work tenant from a personal one.
    var relayOidcTenantId: String?
    /// When this account was captured on this device.
    var relayOidcSignedInAt: Date?

    /// Per-pairing authority to render desktop-owned cached data. Optional so
    /// Keychain blobs written before ADR-026 decode unchanged.
    var desktopAccess: DesktopAccessRecord?

    /// Last account whose credential was explicitly removed during a cancelled
    /// account switch. Displayed as historical context, never as signed-in state.
    var relayOidcPreviousAccount: String?

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

    /// Whether this pairing authenticates to its relay with OIDC tokens minted
    /// on the phone (as opposed to a pre-shared key or a LAN-direct pairing).
    var usesOIDC: Bool {
        relayAuthMode == "oidc"
            && !(relayOidcClientId ?? "").isEmpty
            && !(relayOidcIssuer ?? "").isEmpty
            && !(relayOidcRequiredScope ?? "").isEmpty
    }

    /// Best available label for the bound account, or nil when no identity has
    /// been captured yet for this pairing.
    var oidcAccountLabel: String? {
        if let username = relayOidcAccountUsername, !username.isEmpty { return username }
        if let name = relayOidcAccountName, !name.isEmpty { return name }
        return nil
    }

    /// Host of the OIDC issuer, for a compact "which directory" hint.
    var oidcIssuerHost: String? {
        guard let issuer = relayOidcIssuer, !issuer.isEmpty,
              let host = URL(string: issuer)?.host(percentEncoded: false) else {
            return nil
        }
        return host
    }

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

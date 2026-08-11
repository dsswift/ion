import Foundation
import os

// MARK: - OIDCTokenManagerRegistry

/// One `OIDCTokenManager` per paired desktop, keyed by `PairedDevice.id`.
///
/// ## Why a registry and not a single slot
///
/// A phone can be paired with desktops that authenticate against **different
/// identity tenants through different relays** — a personal Entra tenant on a
/// home relay, a work tenant on a corporate relay. Each pairing therefore needs
/// its own issuer, client ID, scope, cached access token, and Keychain refresh
/// token.
///
/// `SessionViewModel` previously held ONE `oidcTokenManager` and initialized it
/// with `if oidcTokenManager != nil { return }` — no device comparison. Because
/// `switchToDevice` → `disconnect()` → `connect()` never cleared that slot, the
/// second desktop's transport authenticated with the FIRST desktop's manager:
/// wrong issuer, wrong client ID, wrong Keychain key. The relay answered 401 (or
/// 403 for a subject mismatch), the client invalidated and silently refreshed,
/// the refresh returned the same wrong-tenant token, and the backoff ladder
/// retried forever. It self-healed only when LAN/Bonjour connected first and the
/// desktop pushed a fresh `relay_config`; a relay-only roam to the second
/// desktop never recovered at all.
///
/// ## Why instances are kept alive rather than rebuilt
///
/// The obvious alternative — compare `deviceId` on the single slot and rebuild
/// on mismatch — fixes the misroute but throws away the manager's cached access
/// token, its single-flight guard, and its post-cancel cooldown on every desktop
/// switch. Those guards are precisely what stop the reconnect loop from stacking
/// `ASWebAuthenticationSession` sheets (see `OIDCTokenManager`'s
/// `inFlightAcquisition` / `interactiveCooldownUntil`). Holding one live manager
/// per pairing preserves them across switches, which is the lifetime the
/// cooldown already assumes.
///
/// ## Concurrency
///
/// State lives behind an `OSAllocatedUnfairLock` rather than in an actor because
/// `SessionViewModel.connect()` and `softReconnect()` are synchronous and
/// non-isolated: resolving a manager must not require an `await`. This mirrors
/// the lock already used for `TransportManager`'s outbound sequence counter.
/// Logging is always performed OUTSIDE the lock — `DiagnosticLog.log` can block
/// on its transport, and holding an unfair lock across that would serialize
/// connect paths behind a log write.
final class OIDCTokenManagerRegistry: Sendable {

    /// Outcome of a `manager(for:)` resolution, used to log the decision after
    /// the lock is released.
    private enum Resolution {
        case reused
        case created
        case rebuilt
    }

    private let managers = OSAllocatedUnfairLock(initialState: [String: OIDCTokenManager]())

    /// Forwarded to every manager this registry builds, so a token response that
    /// yields an account identity reaches the session layer for persistence onto
    /// the matching `PairedDevice`.
    private let onIdentity: (@Sendable (String, OIDCAccountIdentity) -> Void)?

    init(onIdentity: (@Sendable (String, OIDCAccountIdentity) -> Void)? = nil) {
        self.onIdentity = onIdentity
    }

    // MARK: - Resolution

    /// The manager for this pairing, creating or rebuilding it as needed.
    ///
    /// Returns `nil` when the device is not OIDC-configured (PSK pairings and
    /// LAN-direct pairings mint no tokens). An existing instance is returned
    /// unchanged when every configuration field still matches, so the cached
    /// token and the sign-in guards survive a desktop switch. Any change to
    /// `clientId` / `issuer` / `scope` replaces the instance — a genuinely
    /// different tenant or app registration cannot reuse the old token state.
    func manager(for device: PairedDevice) -> OIDCTokenManager? {
        guard device.relayAuthMode == "oidc",
              let clientId = device.relayOidcClientId,
              let issuer = device.relayOidcIssuer,
              let scope = device.relayOidcRequiredScope,
              !clientId.isEmpty, !issuer.isEmpty, !scope.isEmpty else {
            DiagnosticLog.log("oidc registry: device is not OIDC-configured, no manager", tag: "oidc.registry", fields: [
                "device": String(device.id.prefix(8)),
                "auth_mode": device.relayAuthMode ?? "psk",
                "has_client_id": String(!(device.relayOidcClientId ?? "").isEmpty),
                "has_issuer": String(!(device.relayOidcIssuer ?? "").isEmpty),
                "has_scope": String(!(device.relayOidcRequiredScope ?? "").isEmpty)
            ])
            return nil
        }

        let (manager, resolution) = managers.withLock { store -> (OIDCTokenManager, Resolution) in
            if let existing = store[device.id] {
                if existing.clientId == clientId,
                   existing.issuer == issuer,
                   existing.scope == scope,
                   existing.deviceId == device.id {
                    return (existing, .reused)
                }
                let replacement = OIDCTokenManager(
                    clientId: clientId,
                    issuer: issuer,
                    scope: scope,
                    deviceId: device.id,
                    onIdentity: onIdentity
                )
                store[device.id] = replacement
                return (replacement, .rebuilt)
            }
            let fresh = OIDCTokenManager(
                clientId: clientId,
                issuer: issuer,
                scope: scope,
                deviceId: device.id,
                onIdentity: onIdentity
            )
            store[device.id] = fresh
            return (fresh, .created)
        }

        switch resolution {
        case .reused:
            DiagnosticLog.log("oidc registry: reusing manager", tag: "oidc.registry", fields: [
                "device": String(device.id.prefix(8)),
                "issuer": issuer
            ])
        case .created:
            DiagnosticLog.log("oidc registry: created manager", tag: "oidc.registry", fields: [
                "device": String(device.id.prefix(8)),
                "issuer": issuer
            ])
        case .rebuilt:
            DiagnosticLog.log("oidc registry: rebuilt manager, configuration changed", tag: "oidc.registry", level: .warn, fields: [
                "device": String(device.id.prefix(8)),
                "issuer": issuer
            ])
        }
        return manager
    }

    /// The manager already registered for this pairing, without creating one.
    ///
    /// Used by background paths (inactive-desktop status polling) that must
    /// never provoke an interactive sign-in: no manager means no silent
    /// credential is available, and the caller degrades rather than prompting.
    func existing(deviceId: String) -> OIDCTokenManager? {
        let found = managers.withLock { $0[deviceId] }
        if found == nil {
            DiagnosticLog.log("oidc registry: no manager registered for device", tag: "oidc.registry", fields: [
                "device": String(deviceId.prefix(8))
            ])
        }
        return found
    }

    // MARK: - Removal

    /// Forget this pairing's manager and delete its Keychain refresh token.
    ///
    /// Dropping the in-memory instance alone would leave a live, long-lived
    /// refresh token for a tenant the user has unpaired from sitting in the
    /// Keychain indefinitely. Both halves are the same operation.
    func remove(deviceId: String) {
        let removed = managers.withLock { store -> Bool in
            store.removeValue(forKey: deviceId) != nil
        }
        KeychainHelper.delete(OIDCTokenManager.refreshKey(deviceId: deviceId))
        DiagnosticLog.log("oidc registry: removed manager and refresh token", tag: "oidc.registry", fields: [
            "device": String(deviceId.prefix(8)),
            "had_manager": String(removed)
        ])
    }

    /// Remove several pairings at once (full reset / unpair-all).
    func removeAll(deviceIds: [String]) {
        DiagnosticLog.log("oidc registry: removing all managers", tag: "oidc.registry", fields: [
            "count": String(deviceIds.count)
        ])
        for deviceId in deviceIds {
            remove(deviceId: deviceId)
        }
    }
}

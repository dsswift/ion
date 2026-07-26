import Foundation

// MARK: - Relay Auth Event Handler
//
// Extracted from SessionViewModel+ConnectionEvents.swift to keep that file
// focused on unpair / LAN-auth-rejected events. handleRelayConfig handles
// the desktop_relay_config event: it persists the updated relay URL, API
// key, and OIDC metadata onto the active PairedDevice, then triggers a
// softReconnect when the credential changed (OIDC token rotation).
//
// Runs on the MainActor so it can mutate published state directly.

extension SessionViewModel {

    /// First non-empty string in the given order, or `""` when all are empty.
    /// Used to resolve a relay credential from incoming → in-memory → stored
    /// without ever letting an empty value win.
    func firstNonEmpty(_ candidates: String?...) -> String {
        for candidate in candidates {
            if let value = candidate, !value.isEmpty { return value }
        }
        return ""
    }

    /// Initializes `oidcTokenManager` from the stored `PairedDevice` fields when
    /// the device is in OIDC mode and all required fields are present.
    ///
    /// Called at the top of `connect()` and `softReconnect()` so the credential
    /// factory is always wired before the first connection attempt — not lazily
    /// after desktop pushes a fresh relay_config (which requires a successful
    /// connection first, creating a chicken-and-egg failure on restart).
    ///
    /// Idempotent: skips initialization when a manager already exists for the
    /// same device (avoids discarding a live manager with a cached token on
    /// every softReconnect).
    func ensureOIDCTokenManager(for device: PairedDevice) {
        guard device.relayAuthMode == "oidc",
              let clientId = device.relayOidcClientId,
              let issuer = device.relayOidcIssuer,
              let scope = device.relayOidcRequiredScope,
              !clientId.isEmpty, !issuer.isEmpty, !scope.isEmpty else {
            return
        }
        // Don't replace an existing manager for the same device — it may hold
        // a valid cached access token or an in-progress refresh.
        if oidcTokenManager != nil {
            return
        }
        oidcTokenManager = OIDCTokenManager(
            clientId: clientId,
            issuer: issuer,
            scope: scope,
            deviceId: device.id
        )
        DiagnosticLog.log("oidc: token manager initialized from stored device", tag: "session.relay", fields: [
            "device": String(device.id.prefix(8)),
            "issuer": issuer
        ])
    }

    @MainActor
    func handleRelayConfig(
        relayUrl: String,
        relayApiKey: String,
        authMode: String?,
        relayOidcIssuer: String?,
        relayOidcAudience: String?,
        relayOidcRequiredScope: String?,
        relayOidcClientId: String?
    ) {
        // Desktop pushed updated relay config -- persist it for roaming.
        // Guard: if the active device is a LAN-only pairing (apiKey "lan-direct")
        // and the incoming config doesn't provide BOTH a relay URL and API key,
        // keep the LAN-direct sentinel intact. Without this, a desktop with no
        // relay would overwrite the "lan-direct" marker, breaking reconnects.
        // A legitimate relay upgrade must provide both values.
        if let device = activeDevice, device.relayAPIKey == "lan-direct" {
            // Allow relay upgrades from lan-direct when:
            // (a) PSK mode: both relayUrl and relayApiKey must be non-empty.
            // (b) OIDC mode: relayUrl and OIDC metadata must be present; relayApiKey
            //     may be empty (iOS will mint its own token via OIDCTokenManager).
            let isOidcUpgrade = authMode == "oidc" && relayOidcIssuer != nil && relayOidcClientId != nil
            if !isOidcUpgrade {
                guard !relayUrl.isEmpty, !relayApiKey.isEmpty else {
                    DiagnosticLog.log("relay config rejected empty for lan-direct", tag: "session.relay", level: .warn, fields: [
                        "reason": device.name
                    ])
                    return
                }
            } else {
                guard !relayUrl.isEmpty else {
                    DiagnosticLog.log("relay config rejected: OIDC upgrade missing relay URL", tag: "session.relay", level: .warn, fields: [
                        "reason": device.name
                    ])
                    return
                }
            }
            // Legitimate upgrade from LAN-direct to relay — fall through.
        }

        // Resolve the values to persist. In OIDC mode the desktop sends
        // relayApiKey as a freshly-minted bearer token for bootstrap; if that
        // mint failed or is still in flight, relayApiKey arrives empty.
        //
        // An empty value must NEVER reach the device record. iOS persists what
        // it is given straight into the keychain, so writing "" destroys the
        // pairing's relay config — after which softReconnect has no URL to
        // build a transport from. The fallback chain is:
        //   incoming value -> in-memory value -> stored device value
        // and the write is skipped entirely when all three are empty. The
        // in-memory pair is hydrated from the active device at launch and on
        // every desktop switch (see hydrateRelayConfig), so on a cold start it
        // already holds the stored config rather than "".
        let storedUrl = activeDevice?.relayURL ?? ""
        let storedApiKey = activeDevice?.relayAPIKey ?? ""
        let effectiveUrl = firstNonEmpty(relayUrl, self.relayURL, storedUrl)
        let effectiveApiKey = firstNonEmpty(relayApiKey, self.relayAPIKey, storedApiKey)
        let hasRealToken = !relayApiKey.isEmpty
        let credentialChanged = hasRealToken && (relayApiKey != self.relayAPIKey)

        if !hasRealToken {
            DiagnosticLog.log("relay config carried no usable credential, keeping stored relay config", tag: "session.relay", level: .warn, fields: [
                "auth_mode": authMode ?? "psk",
                "has_stored_url": String(!effectiveUrl.isEmpty),
                "has_stored_key": String(!effectiveApiKey.isEmpty)
            ])
        }

        // Only publish non-empty values. A partial config (URL but no key, or
        // vice versa) still updates the half it actually carries.
        if !effectiveUrl.isEmpty { self.relayURL = effectiveUrl }
        if !effectiveApiKey.isEmpty { self.relayAPIKey = effectiveApiKey }

        if let device = activeDevice,
           let idx = pairedDevices.firstIndex(where: { $0.id == device.id }) {
            if !effectiveUrl.isEmpty { pairedDevices[idx].relayURL = effectiveUrl }
            if !effectiveApiKey.isEmpty { pairedDevices[idx].relayAPIKey = effectiveApiKey }
            // Persist OIDC metadata so reconnects after an app restart carry
            // the auth mode and OIDC context without re-contacting the desktop.
            // This is independently useful even when no credential arrived —
            // iOS mints its own tokens from the issuer + client ID.
            pairedDevices[idx].relayAuthMode = authMode
            pairedDevices[idx].relayOidcIssuer = relayOidcIssuer
            pairedDevices[idx].relayOidcAudience = relayOidcAudience
            pairedDevices[idx].relayOidcRequiredScope = relayOidcRequiredScope
            if let clientId = relayOidcClientId {
                pairedDevices[idx].relayOidcClientId = clientId
            }
            savePairedDevices()
            DiagnosticLog.log("relay config accepted", tag: "session.relay", fields: [
                "device": String(device.id.prefix(8)),
                "auth_mode": authMode ?? "psk",
                "credential_changed": String(credentialChanged),
                "url_written": String(!effectiveUrl.isEmpty),
                "key_written": String(!effectiveApiKey.isEmpty)
            ])
        }

        // Instantiate OIDCTokenManager when fully configured for autonomous acquisition.
        if let device = pairedDevices.first(where: { $0.id == activeDeviceId }),
           device.relayAuthMode == "oidc",
           let clientId = device.relayOidcClientId,
           let oidcIssuer = device.relayOidcIssuer,
           let oidcScope = device.relayOidcRequiredScope,
           !clientId.isEmpty, !oidcIssuer.isEmpty, !oidcScope.isEmpty {
            // Keep the existing manager when its configuration is unchanged.
            // Every relay_config push used to replace the manager; each
            // replacement discarded the in-flight single-flight guard and the
            // post-cancel cooldown, so a config push landing while the user
            // was mid-sign-in spawned a SECOND sign-in sheet on top of the
            // first (and reset the cooldown after a cancel). Desktop pushes
            // relay_config on peer-connect, settings changes, and every
            // proactive token refresh — replacement must be config-driven,
            // not push-driven.
            if let existing = oidcTokenManager,
               existing.clientId == clientId,
               existing.issuer == oidcIssuer,
               existing.scope == oidcScope,
               existing.deviceId == device.id {
                DiagnosticLog.log("oidc: token manager unchanged, keeping existing", tag: "session.relay", fields: [
                    "device": String(device.id.prefix(8))
                ])
            } else {
                oidcTokenManager = OIDCTokenManager(
                    clientId: clientId,
                    issuer: oidcIssuer,
                    scope: oidcScope,
                    deviceId: device.id
                )
                DiagnosticLog.log("oidc: token manager initialized", tag: "session.relay", fields: [
                    "device": String(device.id.prefix(8)),
                    "issuer": oidcIssuer
                ])
            }
        }

        // When the desktop pushes a fresh OIDC token the relayApiKey changes.
        // Reconnect with the new credential so the relay sees the updated bearer
        // token immediately instead of waiting for the old one to expire and
        // trigger a 4401 close.
        if credentialChanged {
            DiagnosticLog.log("relay credential rotated, reconnecting relay", tag: "session.relay", fields: [
                "auth_mode": authMode ?? "psk"
            ])
            // softReconnect tears down and rebuilds the transport using the
            // now-persisted device.relayAPIKey, so the new RelayClient picks
            // up the fresh token from the active device record.
            softReconnect()
        }
    }
}

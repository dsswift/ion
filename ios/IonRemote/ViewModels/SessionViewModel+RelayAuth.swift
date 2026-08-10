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

    /// Credential callbacks for this pairing's relay transport, or nil when the
    /// device is not OIDC-configured (PSK pairings pass their stored key).
    ///
    /// The closures capture the **device ID**, never the manager instance, and
    /// resolve through the registry at call time. That is what pins a live
    /// transport to its own pairing: a phone paired with a personal desktop and
    /// a work desktop in different tenants can switch between them without the
    /// second transport ever resolving the first one's token. Capturing the
    /// instance instead would freeze whichever manager existed at build time —
    /// the same class of bug as the old single slot — and would also miss a
    /// legitimate rebuild triggered by a `relay_config` carrying new OIDC
    /// metadata.
    // Not @MainActor: connect() and softReconnect() are synchronous and
    // nonisolated, and resolving a pairing's credential must not require an
    // await on the connect path. The registry is thread-safe by construction.
    func oidcCredentialClosures(for device: PairedDevice) -> (
        get: @Sendable () async throws -> String,
        rejected: @Sendable () -> Void,
        mismatch: @Sendable () -> Void
    )? {
        guard oidcRegistry.manager(for: device) != nil else { return nil }
        let deviceId = device.id
        let registry: OIDCTokenManagerRegistry = oidcRegistry

        let get: @Sendable () async throws -> String = { [weak self] in
            // Re-resolve on the MainActor so a `relay_config` that changed this
            // pairing's OIDC metadata since the transport was built is honored;
            // fall back to the registry's existing entry when the view model is
            // gone or the pairing has been removed from the list.
            let resolved: OIDCTokenManager? = await MainActor.run {
                guard let self, let device = self.pairedDevices.first(where: { $0.id == deviceId }) else {
                    return registry.existing(deviceId: deviceId)
                }
                return registry.manager(for: device)
            }
            guard let manager = resolved else {
                DiagnosticLog.log("oidc: no manager for device at credential time", tag: "session.relay", level: .error, fields: [
                    "device": String(deviceId.prefix(8))
                ])
                throw OIDCTokenError.managerUnavailable
            }
            do {
                return try await manager.accessToken()
            } catch OIDCTokenError.interactionRequired {
                await MainActor.run {
                    self?.lockDesktop(deviceId: deviceId, reason: .noCredential, source: "silent_oidc_exhausted")
                }
                throw OIDCTokenError.interactionRequired
            }
        }

        let rejected: @Sendable () -> Void = {
            guard let manager = registry.existing(deviceId: deviceId) else {
                DiagnosticLog.log("oidc: token rejected but no manager to invalidate", tag: "session.relay", level: .warn, fields: [
                    "device": String(deviceId.prefix(8))
                ])
                return
            }
            Task { await manager.invalidateAccessToken() }
        }

        let mismatch: @Sendable () -> Void = { [weak self] in
            Task { @MainActor [weak self] in
                self?.handleRelayIdentityMismatch(deviceId: deviceId)
            }
        }

        return (get, rejected, mismatch)
    }

    /// Registry lookup for a pairing that is still in `pairedDevices`, so a
    /// config change picked up since the transport was built is honored.
    @MainActor
    func oidcManagerForConnectedDevice(_ deviceId: String) -> OIDCTokenManager? {
        guard let device = pairedDevices.first(where: { $0.id == deviceId }) else {
            return oidcRegistry.existing(deviceId: deviceId)
        }
        return oidcRegistry.manager(for: device)
    }

    /// The relay refused this pairing because the channel belongs to a different
    /// OIDC subject. Recorded so the UI can offer "Switch Account"; the
    /// transport has already stopped retrying.
    @MainActor
    func handleRelayIdentityMismatch(deviceId: String) {
        let alreadyKnown = relayIdentityMismatch.contains(deviceId)
        relayIdentityMismatch.insert(deviceId)
        if deviceId == activeDevice?.id {
            // A LAN-preferred transport already completed its independent
            // challenge-response handshake. Relay 403 is actionable metadata,
            // not authority loss, until that authenticated LAN path disappears.
            if transport?.state == .lanPreferred {
                DiagnosticLog.log("relay subject mismatch deferred: authenticated LAN remains active", tag: "session.relay", level: .warn, fields: [
                    "device": String(deviceId.prefix(8))
                ])
            } else {
                lockDesktop(deviceId: deviceId, status: .rejected, reason: .wrongAccount, source: "relay_subject_mismatch")
            }
        }
        DiagnosticLog.log("relay refused pairing: channel owned by another identity", tag: "session.relay", level: .error, fields: [
            "device": String(deviceId.prefix(8)),
            "already_known": String(alreadyKnown),
            "is_active": String(deviceId == activeDevice?.id)
        ])
    }

    /// Persist the account behind a pairing's tokens so Settings can show which
    /// identity each desktop is bound to. Display-only (see `OIDCAccountIdentity`).
    @MainActor
    func applyOIDCIdentity(deviceId: String, identity: OIDCAccountIdentity) {
        guard let idx = pairedDevices.firstIndex(where: { $0.id == deviceId }) else {
            DiagnosticLog.log("oidc identity for unknown pairing, discarding", tag: "session.relay", level: .warn, fields: [
                "device": String(deviceId.prefix(8))
            ])
            return
        }
        pairedDevices[idx].relayOidcAccountUsername = identity.username
        pairedDevices[idx].relayOidcAccountName = identity.displayName
        pairedDevices[idx].relayOidcSubject = identity.subject
        pairedDevices[idx].relayOidcTenantId = identity.tenantId
        pairedDevices[idx].relayOidcSignedInAt = identity.issuedAt
        savePairedDevices()
        // A successful token acquisition proves this account is usable; if the
        // pairing was flagged after a subject refusal, that flag is now stale.
        relayIdentityMismatch.remove(deviceId)
        DiagnosticLog.log("oidc identity persisted for pairing", tag: "session.relay", fields: [
            "device": String(deviceId.prefix(8)),
            "has_username": String(!identity.username.isEmpty),
            "has_tenant": String(!identity.tenantId.isEmpty)
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

        // Captured BEFORE the persist block below overwrites them. `activeDevice`
        // is computed from `pairedDevices`, so reading these afterwards would
        // return the values just written and the change comparison would never
        // fire.
        let previousIssuer = activeDevice?.relayOidcIssuer
        let previousClientId = activeDevice?.relayOidcClientId

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

        // Resolve this pairing's token manager against the freshly-persisted
        // config. The registry keeps an existing instance when every field still
        // matches — preserving its cached token, single-flight guard, and
        // post-cancel cooldown — and rebuilds only when the tenant, app
        // registration, or scope actually changed. Desktop pushes relay_config
        // on peer-connect, settings changes, and every proactive token refresh,
        // so replacement must be config-driven, not push-driven.
        //
        // Indexed via `activeDevice` (not a raw `activeDeviceId` lookup) so this
        // agrees with the block above: `activeDevice` falls back to the first
        // pairing when no active ID is set, and the two must not disagree about
        // which device this config was just written to.
        if let device = activeDevice {
            _ = oidcRegistry.manager(for: device)
            // A changed issuer or client ID means a different tenant or app
            // registration is now in play, so a prior subject refusal no longer
            // describes reality. Clear it and let the next attempt be judged on
            // its own.
            let identityContextChanged = previousIssuer != relayOidcIssuer || previousClientId != relayOidcClientId
            if identityContextChanged, relayIdentityMismatch.contains(device.id) {
                relayIdentityMismatch.remove(device.id)
                DiagnosticLog.log("relay identity context changed, clearing mismatch flag", tag: "session.relay", fields: [
                    "device": String(device.id.prefix(8)),
                    "issuer": relayOidcIssuer ?? ""
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

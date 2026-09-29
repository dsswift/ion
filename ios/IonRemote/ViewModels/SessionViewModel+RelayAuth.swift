import Foundation

// MARK: - Relay Auth
//
// The relay URL, API key and OIDC metadata a pairing rides. They arrive with
// the pairing itself now: the `desktop_relay_config` push that used to
// update them mid-session belonged to the retired `desktop_*` wire, and the
// Studio wire carries `relays` on every welcome instead.
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
    /// legitimate rebuild after this pairing's OIDC metadata changed.
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
            // Re-resolve on the MainActor so a change to this pairing's OIDC
            // metadata since the transport was built is honored;
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
                    self?.lockServer(deviceId: deviceId, reason: .noCredential, source: "silent_oidc_exhausted")
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
                lockServer(deviceId: deviceId, status: .rejected, reason: .wrongAccount, source: "relay_subject_mismatch")
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

    /// The bearer for one relay join of this pairing.
    ///
    /// A relay that names its own issuers (`relayOIDC`) is asked which it
    /// accepts, and the pairing is set up to sign in to the one the server
    /// joins with. The relay binds the channel to the server's account, so
    /// only the same person in the same tenant is admitted. Every other relay
    /// uses the pairing's stored OIDC settings.
    func relayToken(for relay: StudioEnvironmentRelay, deviceId: String) async throws -> String {
        if case .relayOIDC(let serverIssuer, let serverClientId) = relay.auth {
            do {
                let entries = try await RelayIssuerDirectory.fetch(relayURL: relay.url)
                let entry = try RelayIssuerDirectory.choose(entries, serverIssuer: serverIssuer, relayURL: relay.url)
                await adoptRelayIssuer(entry, serverClientId: serverClientId, deviceId: deviceId, relayURL: relay.url)
            } catch let choice as RelayIssuerChoiceError {
                DiagnosticLog.log("relay issuers: no usable tenant for this pairing", tag: "session.relay", level: .error, fields: [
                    "device": String(deviceId.prefix(8)), "error": choice.localizedDescription
                ])
                throw choice
            } catch {
                // An unreachable config endpoint does not undo a tenant this
                // pairing already learned; the join below uses it or fails.
                DiagnosticLog.log("relay issuers: could not read the relay's issuers; using the stored sign-in", tag: "session.relay", level: .warn, fields: [
                    "device": String(deviceId.prefix(8)), "error": String(describing: error)
                ])
            }
        }
        let get: (@Sendable () async throws -> String)? = await MainActor.run {
            guard let device = self.pairedDevices.first(where: { $0.id == deviceId }) else { return nil }
            return self.oidcCredentialClosures(for: device)?.get
        }
        guard let get else {
            DiagnosticLog.log("studio route: relay needs a sign-in this pairing does not have", tag: "session.relay", level: .warn, fields: [
                "device": String(deviceId.prefix(8))
            ])
            throw StudioRouteError.relayNeedsIdentity(relayURL: relay.url)
        }
        return try await get()
    }

    /// Points a pairing's OIDC settings at one relay issuer entry, signing in
    /// as `serverClientId` when the server named its sign-in app. Unchanged
    /// settings are left alone, so the token manager and its cached token
    /// survive; a different tenant or app rebuilds the manager (`OIDCTokenManagerRegistry`).
    @MainActor
    func adoptRelayIssuer(_ entry: RelayIssuerEntry, serverClientId: String?, deviceId: String, relayURL: String) {
        guard let idx = pairedDevices.firstIndex(where: { $0.id == deviceId }) else {
            DiagnosticLog.log("relay issuers: pairing is gone, nothing to set up", tag: "session.relay", level: .warn, fields: [
                "device": String(deviceId.prefix(8))
            ])
            return
        }
        let device = pairedDevices[idx]
        let clientId = entry.signInClientId(
            serverClientId: serverClientId, storedIssuer: device.relayOidcIssuer, storedClientId: device.relayOidcClientId
        )
        if device.relayAuthMode == "oidc", device.relayOidcIssuer == entry.issuer, device.relayOidcAudience == entry.audience,
           device.relayOidcRequiredScope == entry.scope, device.relayOidcClientId == clientId {
            return
        }
        pairedDevices[idx].relayAuthMode = "oidc"
        pairedDevices[idx].relayOidcIssuer = entry.issuer
        pairedDevices[idx].relayOidcAudience = entry.audience
        pairedDevices[idx].relayOidcRequiredScope = entry.scope
        pairedDevices[idx].relayOidcClientId = clientId
        savePairedDevices()
        DiagnosticLog.log("relay issuers: pairing set up to sign in to the server's tenant", tag: "session.relay", fields: [
            "device": String(deviceId.prefix(8)), "issuer": entry.issuer, "client_id": clientId,
            "client_source": clientId == serverClientId ? "server" : (clientId == entry.audience ? "relay_audience" : "stored"),
            "relay_host": URL(string: relayURL)?.host(percentEncoded: false) ?? "unknown",
            "previous_issuer": device.relayOidcIssuer ?? "none"
        ])
    }
}


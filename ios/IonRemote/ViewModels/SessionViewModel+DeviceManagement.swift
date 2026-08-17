import Foundation

// MARK: - Device Management

extension SessionViewModel {


    func unpairDevice(_ device: PairedDevice) {
        let isActive = device.id == activeDevice?.id
        // Only send unpair to the desktop if this device is the active connection.
        if isActive {
            Task { try? await transport?.send(.unpair) }
        }
        pairedDevices.removeAll { $0.id == device.id }
        savePairedDevices()
        LayoutCache.delete(deviceId: device.id)
        deviceOnlineStatus.removeValue(forKey: device.id)
        relayIdentityMismatch.remove(device.id)
        // Drop this pairing's token manager AND its Keychain refresh token.
        // A refresh token is long-lived: leaving it behind would keep a usable
        // credential for a tenant the user has just walked away from sitting on
        // the device indefinitely.
        oidcRegistry.remove(deviceId: device.id)

        if pairedDevices.isEmpty {
            activeDeviceId = nil
            disconnect()
        } else if isActive {
            // Auto-switch to the next device.
            let nextId = pairedDevices.first!.id
            switchToDevice(id: nextId)
        }
    }

    /// Push a customization (name / icon override) to the given desktop.
    ///
    /// - For the **active** desktop: reuse the existing live transport and
    ///   `send(.setRemoteDisplay(...))`. The desktop's broadcast comes back
    ///   on the same transport and is reconciled by `handleRemoteDisplay`.
    /// - For an **inactive** desktop: open a transient sidecar transport via
    ///   `OneShotDisplayCommand.send`, await the ack, then tear it down.
    ///   The active session is untouched. If the inactive desktop is
    ///   unreachable the call throws and the caller (the customization
    ///   sheet) reverts the optimistic local update.
    ///
    /// Both paths optimistically write the new values into `pairedDevices`
    /// before sending so the UI updates immediately; LWW reconciliation
    /// happens automatically when the server ack arrives.
    @MainActor
    func updateRemoteDisplay(device: PairedDevice, customName: String?, customIcon: String?) async throws {
        let updatedAt = Date()
        let updatedAtMs = Int(updatedAt.timeIntervalSince1970 * 1000)
        let isActive = device.id == activeDevice?.id
        DiagnosticLog.log("display send", tag: "session.display", fields: [
            "device": String(device.id.prefix(8)),
            "status": String(isActive),
            "reason": customName == nil ? "cleared" : "set",
            "count": String(updatedAtMs)
        ])

        // Optimistic local write — gives the UI an instant response while
        // the round-trip is in flight. Reconciliation overrides this on ack
        // if the desktop applies LWW differently.
        let prevName: String?
        let prevIcon: String?
        let prevTs: Date?
        if let idx = pairedDevices.firstIndex(where: { $0.id == device.id }) {
            prevName = pairedDevices[idx].customName
            prevIcon = pairedDevices[idx].customIcon
            prevTs = pairedDevices[idx].remoteDisplayUpdatedAt
            pairedDevices[idx].customName = customName
            pairedDevices[idx].customIcon = customIcon
            pairedDevices[idx].remoteDisplayUpdatedAt = updatedAt
            savePairedDevices()
        } else {
            prevName = nil
            prevIcon = nil
            prevTs = nil
            DiagnosticLog.log("display send skipping optimistic write", tag: "session.display", fields: [
                "device": String(device.id.prefix(8)),
                "reason": "not in pairedDevices"
            ])
        }

        do {
            if isActive, let transport {
                DiagnosticLog.log("DISPLAY-SEND: using active transport")
                try await transport.send(.setRemoteDisplay(customName: customName, customIcon: customIcon, updatedAt: updatedAt))
                // Active transport: the desktop broadcasts back on this same
                // pipe, picked up by handleRemoteDisplay via the snapshot/
                // .remoteDisplay routing in EventHandlers.swift. Nothing
                // more to do here.
                return
            }

            DiagnosticLog.log("DISPLAY-SEND: using one-shot transport (inactive device)")
            let ack = try await OneShotDisplayCommand.send(
                device: device,
                customName: customName,
                customIcon: customIcon,
                updatedAt: updatedAt,
                // An inactive OIDC pairing still needs ITS OWN token for the
                // sidecar relay connection. Without this the sidecar sent the
                // stored bootstrap key, which in OIDC mode is a stale
                // desktop-minted token (or empty) and is refused.
                getCredential: oidcCredentialClosures(for: device)?.get,
            )
            // Reconcile by applying the server's authoritative value.
            await MainActor.run {
                self.handleRemoteDisplay(
                    deviceId: device.id,
                    customName: ack.customName,
                    customIcon: ack.customIcon,
                    updatedAt: ack.updatedAt,
                )
            }
        } catch {
            // Rollback optimistic write on failure.
            DiagnosticLog.log("display send failed rolling back", tag: "session.display", level: .error, fields: [
                "device": String(device.id.prefix(8)),
                "error": error.localizedDescription
            ])
            if let idx = pairedDevices.firstIndex(where: { $0.id == device.id }) {
                pairedDevices[idx].customName = prevName
                pairedDevices[idx].customIcon = prevIcon
                pairedDevices[idx].remoteDisplayUpdatedAt = prevTs
                savePairedDevices()
            }
            throw error
        }
    }

    // MARK: - Per-pairing OIDC account

    /// Forget the OIDC account bound to this pairing.
    ///
    /// Drops the token manager, deletes the Keychain refresh token, and clears
    /// the cached account fields. The pairing itself survives — the desktop is
    /// still paired, it simply has no identity attached, so the next connection
    /// attempt signs in fresh.
    @MainActor
    func signOutOIDC(device: PairedDevice) {
        DiagnosticLog.log("oidc sign-out requested for pairing", tag: "session.relay", level: .warn, fields: [
            "device": String(device.id.prefix(8)),
            "was_active": String(device.id == activeDevice?.id)
        ])
        oidcRegistry.remove(deviceId: device.id)
        lockDesktop(deviceId: device.id, reason: .signedOut, source: "sign_out")
        relayIdentityMismatch.remove(device.id)
        if let idx = pairedDevices.firstIndex(where: { $0.id == device.id }) {
            pairedDevices[idx].relayOidcAccountUsername = nil
            pairedDevices[idx].relayOidcAccountName = nil
            pairedDevices[idx].relayOidcSubject = nil
            pairedDevices[idx].relayOidcTenantId = nil
            pairedDevices[idx].relayOidcSignedInAt = nil
            savePairedDevices()
        }
        if device.id == activeDevice?.id {
            softReconnect()
        }
    }

    /// Sign in to this pairing with a different account.
    ///
    /// The recovery path when the relay refuses the channel because it is owned
    /// by another OIDC subject: no refresh can change which account the stored
    /// token represents, so the only way through is an interactive sign-in with
    /// the account that owns the channel. User-initiated, so presenting the
    /// browser sheet here is expected rather than intrusive.
    @MainActor
    func switchOIDCAccount(device: PairedDevice) async throws {
        guard let manager = oidcRegistry.manager(for: device) else {
            DiagnosticLog.log("oidc account switch requested for non-OIDC pairing", tag: "session.relay", level: .warn, fields: [
                "device": String(device.id.prefix(8))
            ])
            throw OIDCTokenError.managerUnavailable
        }
        DiagnosticLog.log("oidc account switch starting", tag: "session.relay", fields: [
            "device": String(device.id.prefix(8)),
            "issuer": device.relayOidcIssuer ?? ""
        ])
        let previousAccount = device.oidcAccountLabel
        do {
            _ = try await manager.forceInteractiveReauth()
        } catch OIDCTokenError.interactiveCancelled {
            clearAccountAfterCancelledSwitch(device: device, previousAccount: previousAccount)
            lockDesktop(deviceId: device.id, reason: .userCancelled, source: "switch_account_cancelled")
            throw OIDCTokenError.interactiveCancelled
        } catch {
            clearAccountAfterCancelledSwitch(device: device, previousAccount: previousAccount)
            lockDesktop(deviceId: device.id, reason: .refreshRejected, source: "switch_account_failed")
            DiagnosticLog.log("oidc account switch failed", tag: "session.relay", level: .error, fields: [
                "device": String(device.id.prefix(8)),
                "error": error.localizedDescription
            ])
            throw error
        }
        relayIdentityMismatch.remove(device.id)
        DiagnosticLog.log("oidc account switch succeeded, entering verification", tag: "session.relay", fields: [
            "device": String(device.id.prefix(8))
        ])
        setDesktopAccess(DesktopAccessRecord(
            status: .verifying, reason: .none,
            changedAt: Date(),
            lastAuthorizedAt: pairedDevices.first(where: { $0.id == device.id })?.desktopAccess?.lastAuthorizedAt
        ), deviceId: device.id, source: "switch_account_verifying")
        if device.id == activeDevice?.id {
            softReconnect()
        }
    }

    @MainActor
    private func clearAccountAfterCancelledSwitch(device: PairedDevice, previousAccount: String?) {
        if let index = pairedDevices.firstIndex(where: { $0.id == device.id }) {
            pairedDevices[index].relayOidcPreviousAccount = previousAccount
            pairedDevices[index].relayOidcAccountUsername = nil
            pairedDevices[index].relayOidcAccountName = nil
            pairedDevices[index].relayOidcSubject = nil
            pairedDevices[index].relayOidcTenantId = nil
            pairedDevices[index].relayOidcSignedInAt = nil
            savePairedDevices()
        }
    }

    func resetAll() {
        Task {
            try? await transport?.send(.unpair)
            await MainActor.run {
                // Purge every pairing's OIDC manager and Keychain refresh token
                // BEFORE the device list is cleared — the IDs are the only way
                // to find those Keychain entries, and losing them would strand
                // live refresh tokens on the device.
                self.oidcRegistry.removeAll(deviceIds: self.pairedDevices.map(\.id))
                self.relayIdentityMismatch = []
                self.disconnect()
                self.pairedDevices = []
                self.activeDeviceId = nil
                self.hasConnectedBefore = false
                UserDefaults.standard.set(false, forKey: "hasConnectedBefore")
                self.conversationInstances = [:]
                self.activeEngineInstance = [:]
                self.loadingConversation = []
                self.conversationLoaded = []
                self.conversationHasMore = [:]
                self.conversationCursor = [:]
                self.tabs = []
                self.relayURL = ""
                self.relayAPIKey = ""
                self.pairingState = .idle
                self.deviceOnlineStatus = [:]
                do {
                    try KeychainStore.deleteAll()
                } catch {
                    DiagnosticLog.log("failed to delete paired devices during reset", tag: "pairing", level: .error, fields: ["error": error.localizedDescription])
                }
                LayoutCache.deleteAll()
            }
        }
    }

    func saveRelayConfig() {
        guard let device = activeDevice,
              let idx = pairedDevices.firstIndex(where: { $0.id == device.id }) else { return }
        pairedDevices[idx].relayURL = relayURL
        pairedDevices[idx].relayAPIKey = relayAPIKey
        savePairedDevices()
    }

    // MARK: - Persistence

    func loadPairedDevices() {
        do {
            pairedDevices = try KeychainStore.loadPairedDevices()
        } catch {
            // A load failure leaves the app with no known pairings; surface it
            // so the empty device list is explained rather than silently blamed
            // on the user never having paired.
            pairedDevices = []
            DiagnosticLog.log("failed to load paired devices from keychain", tag: "pairing", level: .error, fields: [
                "error": String(describing: error)
            ])
        }
        Task { @MainActor [weak self] in
            self?.normalizeDesktopAccessRecords()
        }
        hydrateRelayConfig()
    }

    /// Populate the in-memory `relayURL` / `relayAPIKey` from the active
    /// device's persisted record.
    ///
    /// These two properties start empty on every launch and were previously
    /// only ever written by `completePairing` or an inbound `relay_config`.
    /// That made them a *destructive* fallback: `handleRelayConfig` treats them
    /// as the "keep what we have" source when an incoming config carries no
    /// token, so on a fresh launch it fell back onto `""` and wrote empty
    /// values over a perfectly good stored relay config — after which
    /// `softReconnect` had no URL to connect to and the app could not recover.
    ///
    /// Called after `loadPairedDevices()` and on every desktop switch (the
    /// values are per-device, so they must follow the active device).
    func hydrateRelayConfig() {
        guard let device = activeDevice else {
            DiagnosticLog.log("relay config hydrate skipped, no active device", tag: "session.relay")
            return
        }
        // Non-empty guard, matching handleRelayConfig's rule for the same two
        // properties. On the loadPairedDevices path the in-memory values are
        // empty and the stored record is the only truth, so this is a plain
        // write. On the switchDesktop path it is not: if the new device's
        // stored record is empty but a relay_config push has already landed for
        // it in this session, an unconditional write would clobber a good live
        // value with "" — reintroducing the exact empty-value defect
        // handleRelayConfig was hardened against. Ordering makes that narrow
        // today (switchDesktop disconnects first), which is precisely why the
        // asymmetry should not be left to luck.
        if let storedURL = device.relayURL, !storedURL.isEmpty {
            relayURL = storedURL
        }
        if let storedKey = device.relayAPIKey, !storedKey.isEmpty {
            relayAPIKey = storedKey
        }
        DiagnosticLog.log("relay config hydrated from device", tag: "session.relay", fields: [
            "device": String(device.id.prefix(8)),
            "has_url": String(!relayURL.isEmpty),
            "has_key": String(!relayAPIKey.isEmpty),
            "stored_url_empty": String((device.relayURL ?? "").isEmpty),
            "stored_key_empty": String((device.relayAPIKey ?? "").isEmpty),
            "auth_mode": device.relayAuthMode ?? "psk"
        ])
    }

    func savePairedDevices() {
        do {
            try KeychainStore.savePairedDevices(pairedDevices)
        } catch {
            // A save failure silently loses pairings on the next launch; never
            // swallow it.
            DiagnosticLog.log("failed to save paired devices to keychain", tag: "pairing", level: .error, fields: [
                "error": String(describing: error),
                "device_count": String(pairedDevices.count)
            ])
        }
    }
}

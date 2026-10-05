import Foundation

// MARK: - Device Management

extension SessionViewModel {


    /// Forgets a pairing on this phone and on the server. The active server
    /// is told over the live connection. Any other server is told over its
    /// own admin connection, which needs the pairing's credentials, so those
    /// are dropped only once the server has answered or could not be reached.
    /// Returns the task that drops them then, or nil when they are already gone.
    @MainActor
    @discardableResult
    func unpairDevice(_ device: PairedDevice) -> Task<Void, Never>? {
        let isActive = device.id == activeDevice?.id
        let deviceId = device.id
        let serverId = studioRecord(for: device)?.clientId
        var revoke: Task<Void, Never>?
        if isActive {
            Task {
                do {
                    try await transport?.send(.unpair)
                } catch {
                    DiagnosticLog.log("unpair send failed", tag: "pairing", level: .warn, fields: [
                        "device": String(deviceId.prefix(8)),
                        "error": error.localizedDescription
                    ])
                }
            }
        } else if let session = adminSession(for: device) {
            let client = session.client
            revoke = Task { await Self.revokePairing(on: client, deviceId: deviceId) }
        }
        forgetLocally(deviceId: device.id)
        savePairedDevices()
        var cleanup: Task<Void, Never>?
        if let revoke {
            cleanup = Task { @MainActor [weak self] in
                await revoke.value
                self?.dropCredentials(deviceId: deviceId, serverId: serverId)
            }
        } else {
            dropCredentials(deviceId: deviceId, serverId: serverId)
        }

        if pairedDevices.isEmpty {
            activeDeviceId = nil
            disconnect()
        } else if isActive {
            // Auto-switch to the next device.
            let nextId = pairedDevices.first!.id
            switchToDevice(id: nextId)
        }
        return cleanup
    }

    /// Removes a pairing from the list and drops what this phone cached for it.
    /// The caller saves the list.
    func forgetLocally(deviceId: String) {
        pairedDevices.removeAll { $0.id == deviceId }
        LayoutCache.delete(deviceId: deviceId)
        deviceOnlineStatus.removeValue(forKey: deviceId)
        relayIdentityMismatch.remove(deviceId)
    }

    /// Drops what reaching an unpaired server needed: its admin session, its
    /// stored Studio credential, its token manager, and its Keychain refresh
    /// token. A refresh token is long-lived: leaving it behind would keep a
    /// usable credential for a tenant the user has just walked away from
    /// sitting on the device.
    @MainActor
    func dropCredentials(deviceId: String, serverId: String?) {
        if let serverId {
            dropAdminSession(serverId: serverId)
            removeStudioRecords(clientIds: [serverId], store: StudioServerKeychainStore())
        }
        oidcRegistry.remove(deviceId: deviceId)
    }

    /// Takes the named records out of the stored Studio servers. False when
    /// the store could not be read or written.
    @discardableResult
    func removeStudioRecords(clientIds: Set<String>, store: any StudioServerStoring) -> Bool {
        do {
            let records = try store.load()
            let kept = records.filter { !clientIds.contains($0.clientId) }
            guard kept.count != records.count else { return true }
            try store.save(kept)
            DiagnosticLog.log("studio servers: credentials removed", tag: "pairing", fields: [
                "removed": String(records.count - kept.count), "remaining": String(kept.count)
            ])
            return true
        } catch {
            DiagnosticLog.log("studio servers: credentials could not be removed", tag: "pairing", level: .error, fields: [
                "count": String(clientIds.count), "error": String(describing: error)
            ])
            return false
        }
    }

    /// Drops every pairing a newer pairing to the same server replaced: its
    /// list entry, its cache, and its stored Studio credential. When the
    /// selected pairing is one of them, the selection moves to the pairing
    /// that replaced it. Returns what was dropped.
    @discardableResult
    func dropSupersededPairings(store: any StudioServerStoring = StudioServerKeychainStore()) -> [SupersededPairings.Stale] {
        let records: [StudioServerRecord]
        do {
            records = try store.load()
        } catch {
            DiagnosticLog.log("superseded pairings: stored servers unreadable, nothing dropped", tag: "pairing", level: .error, fields: [
                "error": String(describing: error)
            ])
            return []
        }
        let stale = SupersededPairings.find(devices: pairedDevices, records: records)
        guard !stale.isEmpty else {
            DiagnosticLog.log("superseded pairings: none", tag: "pairing", level: .debug, fields: [
                "devices": String(pairedDevices.count)
            ])
            return []
        }
        // The credential goes first. A pairing whose credential could not be
        // removed stays listed, so it can still be unpaired by hand.
        guard removeStudioRecords(clientIds: Set(stale.map(\.clientId)), store: store) else { return [] }
        for entry in stale {
            if activeDeviceId == entry.deviceId { activeDeviceId = entry.keptDeviceId }
            forgetLocally(deviceId: entry.deviceId)
            DiagnosticLog.log("superseded pairings: older pairing dropped", tag: "pairing", fields: [
                "device": String(entry.deviceId.prefix(8)), "client_id": entry.clientId,
                "kept": String(entry.keptDeviceId.prefix(8))
            ])
        }
        savePairedDevices()
        return stale
    }

    /// Asks a server to forget this phone's pairing. A server that cannot be
    /// reached keeps the pairing until it is revoked from another device.
    static func revokePairing(on client: ServerAdminClient, deviceId: String) async {
        do {
            try await client.forgetThisPhone()
            DiagnosticLog.log("unpair: server forgot this phone", tag: "pairing", fields: [
                "device": String(deviceId.prefix(8)), "server": client.serverLabel
            ])
        } catch {
            DiagnosticLog.log("unpair: server could not be told, pairing stays on it", tag: "pairing", level: .warn, fields: [
                "device": String(deviceId.prefix(8)), "server": client.serverLabel, "error": String(describing: error)
            ])
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
    /// The sidecar write, over the Studio wire. A pairing with no stored
    /// Studio credential has no sidecar to open, so the call throws and the
    /// customization sheet reverts its optimistic write.
    @MainActor
    private func oneShotDisplay(
        device: PairedDevice, customName: String?, customIcon: String?, updatedAt: Date
    ) async throws -> RemoteDisplayAck {
        guard let record = studioRecord(for: device) else {
            DiagnosticLog.log("oneshot display: no studio credential for this pairing", tag: "session.display", level: .error, fields: [
                "device": String(device.id.prefix(8))
            ])
            throw OneShotDisplayError.unreachable
        }
        return try await OneShotDisplayCommand.send(
            studio: record, deviceId: device.id, customName: customName, customIcon: customIcon,
            updatedAt: updatedAt, oidcToken: oidcCredentialClosures(for: device)?.get)
    }

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
            let ack = try await oneShotDisplay(
                device: device, customName: customName, customIcon: customIcon, updatedAt: updatedAt)
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
        lockServer(deviceId: device.id, reason: .signedOut, source: "sign_out")
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
            lockServer(deviceId: device.id, reason: .userCancelled, source: "switch_account_cancelled")
            throw OIDCTokenError.interactiveCancelled
        } catch {
            clearAccountAfterCancelledSwitch(device: device, previousAccount: previousAccount)
            lockServer(deviceId: device.id, reason: .refreshRejected, source: "switch_account_failed")
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
        setServerAccess(ServerAccessRecord(
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
            do {
                try await transport?.send(.unpair)
            } catch {
                DiagnosticLog.log("reset-all unpair send failed", tag: "pairing", level: .warn, fields: [
                    "error": error.localizedDescription
                ])
            }
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
                self.transcriptStreams = [:]
                self.transcriptResyncing = []
                self.transcriptOlderInFlight = []
                self.pendingPrompts = [:]
                self.agentConversationMessages = [:]
                self.agentConversationLoading = []
                self.dispatchStreams = [:]
                self.dispatchResyncing = []
                self.dispatchTabs = [:]
                self.agentConversationGroups = [:]
                self.loadingConversation = []
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
            // Only a successful load names the pairings. An empty list from a
            // failed load would release every server's unshipped log lines.
            DiagnosticLog.setKnownPairings(pairedDevices.map(\.id))
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
            self?.normalizeServerAccessRecords()
        }
        StudioServerMigration.run(devices: pairedDevices, store: StudioServerKeychainStore())
        dropSupersededPairings()
        hydrateRelayConfig()
    }

    /// Populate the in-memory `relayURL` / `relayAPIKey` from the active
    /// device's persisted record.
    ///
    /// These two properties start empty on every launch, so without this the
    /// app holds `""` while a perfectly good relay config sits in the stored
    /// record — after which `softReconnect` has no URL to dial and cannot
    /// recover.
    ///
    /// Called after `loadPairedDevices()` and on every server switch (the
    /// values are per-pairing, so they must follow the active one).
    func hydrateRelayConfig() {
        guard let device = activeDevice else {
            DiagnosticLog.log("relay config hydrate skipped, no active device", tag: "session.relay")
            return
        }
        // Non-empty guard. On the loadPairedDevices path the in-memory values
        // are empty and the stored record is the only truth, so this is a
        // plain write. On the switch path it is not: an unconditional write
        // would clobber a good live value with "" whenever the incoming
        // record happens to be empty.
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
        DiagnosticLog.setKnownPairings(pairedDevices.map(\.id))
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

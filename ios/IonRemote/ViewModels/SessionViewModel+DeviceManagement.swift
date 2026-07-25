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

    func resetAll() {
        Task {
            try? await transport?.send(.unpair)
            await MainActor.run {
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
                try? KeychainStore.deleteAll()
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

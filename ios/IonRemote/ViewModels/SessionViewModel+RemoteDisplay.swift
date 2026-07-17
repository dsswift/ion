import Foundation

// MARK: - Remote display (per-desktop name/icon override) reconciliation

extension SessionViewModel {

    /// Apply an inbound `remote_display` update to the cached `PairedDevice`
    /// entry for the given desktop. Called from three places:
    ///
    /// 1. `.remoteDisplay` event on the active transport (live broadcast
    ///    from the desktop after any phone — or the desktop UI — saved a
    ///    new value).
    /// 2. `.snapshot` event on the active transport (offline-catchup path:
    ///    a phone that was offline at write time reads the current value
    ///    on reconnect).
    /// 3. The ack received by `OneShotDisplayCommand` after a write to an
    ///    *inactive* desktop. The one-shot helper invokes this via
    ///    `SessionViewModel.updateRemoteDisplay(device:...)`.
    ///
    /// LWW: only newer timestamps override the cached value. Equal-or-older
    /// timestamps are dropped to silently reconcile concurrent edits.
    /// The very first apply (cached `remoteDisplayUpdatedAt == nil`) is
    /// always accepted regardless of timestamp ordering, so a fresh client
    /// can pick up the desktop's existing override on first sync.
    @MainActor
    func handleRemoteDisplay(
        deviceId: String,
        customName: String?,
        customIcon: String?,
        updatedAt: Date,
    ) {
        let incomingMs = Int(updatedAt.timeIntervalSince1970 * 1000)
        guard let idx = pairedDevices.firstIndex(where: { $0.id == deviceId }) else {
            DiagnosticLog.log("remote display recv device not found", tag: "session.display", level: .warn, fields: [
                "device": String(deviceId.prefix(8)),
                "count": String(pairedDevices.count)
            ])
            return
        }

        let cachedTs = pairedDevices[idx].remoteDisplayUpdatedAt
        let existingMs = cachedTs.map { Int($0.timeIntervalSince1970 * 1000) } ?? 0
        if cachedTs != nil && incomingMs <= existingMs {
            DiagnosticLog.log("remote display recv stale", tag: "session.display", level: .debug, fields: [
                "device": String(deviceId.prefix(8)),
                "count": String(incomingMs),
                "max": String(existingMs)
            ])
            return
        }

        let nameDescr = customName == nil ? "cleared" : "set"
        let iconDescr = customIcon ?? "cleared"
        DiagnosticLog.log("remote display recv applied", tag: "session.display", level: .debug, fields: [
            "device": String(deviceId.prefix(8)),
            "reason": nameDescr,
            "status": iconDescr,
            "count": String(incomingMs),
            "max": String(existingMs)
        ])

        pairedDevices[idx].customName = customName
        pairedDevices[idx].customIcon = customIcon
        pairedDevices[idx].remoteDisplayUpdatedAt = updatedAt
        savePairedDevices()
    }

    /// Snapshot-carried remoteDisplay routing. Called from the `.snapshot`
    /// branch of `handleEvent` — splits out the routing detail (look up
    /// active device, log the no-device and legacy-snapshot paths) to keep
    /// the event-handlers file under the size cap.
    @MainActor
    func applySnapshotRemoteDisplay(
        customName: String?,
        customIcon: String?,
        updatedAt: Date?,
    ) {
        guard let updatedAt else {
            DiagnosticLog.log("SNAP: no remote_display field (legacy desktop or unset override)")
            return
        }
        guard let device = activeDevice else {
            DiagnosticLog.log("SNAP: remote_display field present but no activeDevice — skipping")
            return
        }
        DiagnosticLog.log("snapshot applying remote display", tag: "session.display", level: .debug, fields: [
            "reason": customName == nil ? "nil" : "set",
            "status": customIcon ?? "nil",
            "count": String(Int(updatedAt.timeIntervalSince1970 * 1000))
        ])
        handleRemoteDisplay(
            deviceId: device.id,
            customName: customName,
            customIcon: customIcon,
            updatedAt: updatedAt,
        )
    }

    /// Live `.remoteDisplay` event routing. Inbound from the active transport
    /// only — the one-shot path uses its own routing via
    /// `OneShotDisplayCommand` + `updateRemoteDisplay(device:...)`.
    @MainActor
    func applyLiveRemoteDisplay(
        customName: String?,
        customIcon: String?,
        updatedAt: Date,
    ) {
        guard let device = activeDevice else {
            DiagnosticLog.log("DISPLAY-RECV: ignored — no activeDevice")
            return
        }
        handleRemoteDisplay(
            deviceId: device.id,
            customName: customName,
            customIcon: customIcon,
            updatedAt: updatedAt,
        )
    }
}

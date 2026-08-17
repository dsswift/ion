import Foundation

extension SessionViewModel {
    @MainActor
    func normalizeDesktopAccessRecords() {
        var changed = false
        for index in pairedDevices.indices {
            let normalized = DesktopAccessPolicy.normalizedForLaunch(pairedDevices[index].desktopAccess)
            if pairedDevices[index].desktopAccess != normalized {
                pairedDevices[index].desktopAccess = normalized
                changed = true
            }
        }
        if changed { savePairedDevices() }
    }

    @MainActor
    func setDesktopAccess(_ record: DesktopAccessRecord, deviceId: String, source: String) {
        guard let index = pairedDevices.firstIndex(where: { $0.id == deviceId }) else { return }
        pairedDevices[index].desktopAccess = record
        savePairedDevices()
        reportMobileAuth(deviceId: deviceId, record: record)
        DiagnosticLog.log("desktop access changed", tag: "session.access", fields: [
            "device": String(deviceId.prefix(8)), "status": record.status.rawValue,
            "reason": record.reason.rawValue, "source": source
        ])
    }

    @MainActor
    func authorizeDesktop(deviceId: String, synchronizedAt: Date = Date()) {
        setDesktopAccess(DesktopAccessRecord(status: .authorized, reason: .none, changedAt: synchronizedAt, lastAuthorizedAt: synchronizedAt), deviceId: deviceId, source: "authenticated_snapshot")
        lastSynchronizedAt[deviceId] = synchronizedAt
        if let pending = pendingExternalNavigation, pending.deviceId == deviceId {
            pendingNavigationTabId = pending.tabId
            pendingExternalNavigation = nil
        }
    }

    @MainActor
    func lockDesktop(deviceId: String, status: DesktopAccessRecord.Status = .authenticationRequired, reason: DesktopAccessRecord.Reason, source: String) {
        let prior = pairedDevices.first(where: { $0.id == deviceId })?.desktopAccess
        if prior?.status == .verifying && reason != .wrongAccount {
            DiagnosticLog.log("lock suppressed during verification", tag: "session.access", fields: [
                "device": String(deviceId.prefix(8)), "reason": reason.rawValue, "source": source
            ])
            return
        }
        setDesktopAccess(DesktopAccessRecord(status: status, reason: reason, changedAt: Date(), lastAuthorizedAt: prior?.lastAuthorizedAt), deviceId: deviceId, source: source)
        if deviceId == activeDevice?.id {
            // ContentView replaces the whole desktop-owned subtree, including
            // tabs/resources/conversations. Cache remains on disk for recovery.
            pendingNavigationTabId = nil
        }
    }

    @MainActor
    func markActiveDesktopTransientlyDisconnected(source: String) {
        guard let device = activeDevice else { return }
        let prior = device.desktopAccess ?? .startup()
        guard prior.status == .authorized || prior.status == .startup || prior.status == .transientlyDisconnected else { return }
        setDesktopAccess(DesktopAccessRecord(status: .transientlyDisconnected, reason: .none, changedAt: Date(), lastAuthorizedAt: prior.lastAuthorizedAt), deviceId: device.id, source: source)
    }

    @MainActor
    func reportMobileAuth(deviceId: String, record: DesktopAccessRecord) {
        guard deviceId == activeDevice?.id,
              let device = pairedDevices.first(where: { $0.id == deviceId }) else { return }
        send(.reportMobileAuth(
            accountUsername: device.relayOidcAccountUsername,
            accountName: device.relayOidcAccountName,
            subject: device.relayOidcSubject,
            tenantId: device.relayOidcTenantId,
            signedInAt: device.relayOidcSignedInAt,
            clearIdentity: device.relayOidcPreviousAccount != nil && device.oidcAccountLabel == nil,
            accessStatus: record.status.rawValue,
            accessReason: record.reason.rawValue,
            reportedAt: record.changedAt
        ), intent: .automaticEssential)
    }

    @MainActor
    func lockDeferredRelayMismatchIfNeeded() {
        guard let device = activeDevice,
              relayIdentityMismatch.contains(device.id),
              transport?.state != .lanPreferred else { return }
        lockDesktop(deviceId: device.id, status: .rejected, reason: .wrongAccount, source: "authenticated_lan_lost_after_relay_mismatch")
    }

    @MainActor
    func navigateToExternalTab(deviceId: String, tabId: String) {
        activeDeviceId = deviceId
        if DesktopAccessPolicy.mayNavigate(pairedDevices.first(where: { $0.id == deviceId })?.desktopAccess) {
            pendingNavigationTabId = tabId
        } else {
            pendingExternalNavigation = (deviceId, tabId)
        }
    }
    /// Navigate to a specific tab (e.g. from a push notification tap).
    func navigateToTab(_ tabId: String) {
        // Internal live navigation follows existing behavior. External APNs
        // navigation goes through navigateToExternalTab so it cannot bypass the
        // per-pairing access gate.
        pendingNavigationTabId = tabId
    }

    var activeDesktopAccess: DesktopAccessRecord {
        activeDevice?.desktopAccess ?? .startup()
    }

    var mayViewActiveDesktopData: Bool {
        DesktopAccessPolicy.mayViewDesktopData(activeDevice?.desktopAccess)
    }

    var activeDesktopIsLocked: Bool {
        !mayViewActiveDesktopData
    }

    var activeDesktopIsVerifying: Bool {
        DesktopAccessPolicy.isVerifying(activeDevice?.desktopAccess)
    }


}

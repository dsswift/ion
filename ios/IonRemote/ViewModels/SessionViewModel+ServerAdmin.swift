import Foundation

// MARK: - Server administration
//
// Settings pages administer any paired server, not only the connected one.
// Each server gets one `ServerAdminSession`, which calls through the live
// transport when that server is the connected one and through a dedicated
// transport of its own otherwise.

extension SessionViewModel {

    /// The admin session for `device`, made on first use. Nil when the
    /// pairing has no stored Studio credential.
    @MainActor
    func adminSession(for device: PairedDevice) -> ServerAdminSession? {
        guard let record = studioRecord(for: device) else {
            DiagnosticLog.log("admin session: no studio credential for this pairing", tag: "admin.session", level: .error, fields: [
                "device": String(device.id.prefix(8))
            ])
            return nil
        }
        let serverId = record.clientId
        if let existing = adminSessionsByServer[serverId] { return existing }
        let session = ServerAdminSession(
            serverId: serverId,
            serverLabel: device.displayName,
            live: { [weak self] in
                guard let live = self?.transport as? StudioTransport, live.serverId == serverId else { return nil }
                return live
            },
            liveSettings: { [weak self] in self?.serverSettings },
            build: { [weak self] in self?.makeAdminTransport(for: device) }
        )
        adminSessionsByServer[serverId] = session
        DiagnosticLog.log("admin session: created", tag: "admin.session", fields: [
            "server_id": serverId, "device": String(device.id.prefix(8))
        ])
        return session
    }

    /// Stops and forgets the admin session for a server that was unpaired.
    @MainActor
    func dropAdminSession(serverId: String) {
        guard let session = adminSessionsByServer.removeValue(forKey: serverId) else { return }
        session.shutdown(reason: "unpaired")
    }

    /// A transport to `device` that leaves the live session alone. Like the
    /// one-shot display write it does not browse for the server's address:
    /// the stored address is tried and the relays are the fallback.
    @MainActor
    private func makeAdminTransport(for device: PairedDevice) -> StudioTransport? {
        // Read again at build time: welcomes since the session was made may
        // have moved the server's address or relays.
        guard let record = studioRecord(for: device) else { return nil }
        let deviceId = device.id
        var inputs = TransportFactory.StudioInputs(record: record, deviceId: deviceId)
        inputs.discoversAddress = false
        inputs.oidcToken = { [weak self] relay in
            guard let self else { throw StudioRouteError.routeReleased }
            return try await self.relayToken(for: relay, deviceId: deviceId)
        }
        return TransportFactory.makeStudioTransport(inputs)
    }
}

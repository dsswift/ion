import Foundation

/// Carries pairings made on the older wire over to the Studio wire.
///
/// The server does the same on its side: a phone it knows as a paired device
/// becomes a client whose id is derived from the shared secret, with that same
/// secret. So the phone needs no new pairing; it needs a record that names the
/// id the server derived. The id is computed from the secret here too, never
/// read from a stored field, so both sides agree by construction.
///
/// Runs at every launch and only adds what is missing. The paired-device
/// records are left as they are.
enum StudioServerMigration {

    struct Outcome: Equatable {
        var migrated: [String] = []
        /// Paired-device id to the reason it was skipped.
        var skipped: [String: String] = [:]
    }

    /// The bytes a usable shared secret has.
    static let secretLength = 32

    @discardableResult
    static func run(devices: [PairedDevice], store: any StudioServerStoring) -> Outcome {
        var outcome = Outcome()
        var records: [StudioServerRecord]
        do {
            records = try store.load()
        } catch {
            DiagnosticLog.log("studio migration: stored servers unreadable, nothing migrated", tag: "studio.migrate", level: .error, fields: [
                "error": String(describing: error)
            ])
            return outcome
        }
        guard !devices.isEmpty else {
            DiagnosticLog.log("studio migration: no paired devices to migrate", tag: "studio.migrate", level: .debug)
            return outcome
        }
        for device in devices {
            let devicePrefix = String(device.id.prefix(8))
            guard let record = record(from: device) else {
                let reason = skipReason(for: device)
                outcome.skipped[device.id] = reason
                DiagnosticLog.log("studio migration: paired device skipped", tag: "studio.migrate", level: .warn, fields: [
                    "device": devicePrefix, "reason": reason
                ])
                continue
            }
            if records.contains(where: { $0.clientId == record.clientId }) {
                outcome.skipped[device.id] = "already a studio server record"
                DiagnosticLog.log("studio migration: paired device skipped", tag: "studio.migrate", level: .debug, fields: [
                    "device": devicePrefix, "reason": "already a studio server record"
                ])
                continue
            }
            records.append(record)
            outcome.migrated.append(device.id)
            DiagnosticLog.log("studio migration: paired device migrated", tag: "studio.migrate", fields: [
                "device": devicePrefix, "client_id": record.clientId, "relay_count": String(record.relays.count),
                "has_machine_id": String(record.machineId != nil), "id_matches_device": String(record.clientId == device.id)
            ])
        }
        guard !outcome.migrated.isEmpty else { return outcome }
        do {
            try store.save(records)
            DiagnosticLog.log("studio migration: finished", tag: "studio.migrate", fields: [
                "migrated": String(outcome.migrated.count), "skipped": String(outcome.skipped.count)
            ])
        } catch {
            DiagnosticLog.log("studio migration: could not store the migrated records", tag: "studio.migrate", level: .error, fields: [
                "error": String(describing: error)
            ])
            outcome.skipped.merge(outcome.migrated.map { ($0, "could not be stored") }) { _, new in new }
            outcome.migrated = []
        }
        return outcome
    }

    /// The Studio record for one paired device, or nil when it cannot have one.
    static func record(from device: PairedDevice) -> StudioServerRecord? {
        guard device.connectionKind != "direct", device.sharedSecret.count == secretLength else { return nil }
        return StudioServerRecord(
            clientId: StudioServerRecord.clientId(forSecret: device.sharedSecret),
            secret: device.sharedSecret,
            url: nil,
            environmentId: nil,
            machineId: device.desktopId,
            label: device.displayName,
            relays: relays(from: device),
            pairedDeviceId: device.id
        )
    }

    private static func skipReason(for device: PairedDevice) -> String {
        if device.connectionKind == "direct" { return "a direct connection holds a bearer token, not a shared secret" }
        return "stored secret is not \(secretLength) bytes"
    }

    /// The relay this pairing used on the older wire, in the Studio wire's shape.
    static func relays(from device: PairedDevice) -> [StudioEnvironmentRelay] {
        let urls = ([device.relayURL].compactMap { $0 } + (device.relayUrls ?? []))
            .filter { !$0.isEmpty }
            .reduce(into: [String]()) { list, url in if !list.contains(url) { list.append(url) } }
        if device.relayAuthMode == "oidc" {
            guard let issuer = device.relayOidcIssuer, !issuer.isEmpty,
                  let scope = device.relayOidcRequiredScope, !scope.isEmpty else {
                return urls.map { StudioEnvironmentRelay(url: $0, auth: .relayOIDC(issuer: nil, clientId: nil)) }
            }
            return urls.map { StudioEnvironmentRelay(url: $0, auth: .oidc(issuer: issuer, audience: device.relayOidcAudience ?? "", scope: scope)) }
        }
        // A pairing made over the LAN with no relay stored the LAN address and
        // this marker key in the relay fields. That is not a relay.
        guard let key = device.relayAPIKey, !key.isEmpty, key != "lan-direct" else { return [] }
        return urls.map { StudioEnvironmentRelay(url: $0, auth: .psk(key: key)) }
    }
}

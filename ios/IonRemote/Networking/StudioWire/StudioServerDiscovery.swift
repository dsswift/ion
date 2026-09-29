import Foundation

/// Finds the address of a server this phone is already paired with, from the
/// server's own LAN announcement (`_ion-studio._tcp`).
///
/// Only a record with no address needs this, which is what a pairing carried
/// over from the older wire is. Connecting never waits on it: the relays work
/// without an address, and a server that does not announce itself is still
/// reached through them.
enum StudioServerDiscovery {

    /// The announced server that is `record`'s, if any. A machine id match
    /// wins; an environment id match is the fallback for a record that learned
    /// its environment from a welcome.
    static func match(for record: StudioServerRecord, in services: [DiscoveredService]) -> DiscoveredService? {
        if let machineId = record.machineId, !machineId.isEmpty,
           let found = services.first(where: { $0.metadata["machine"] == machineId }) {
            return found
        }
        if let environmentId = record.environmentId, !environmentId.isEmpty,
           let found = services.first(where: { $0.metadata["id"] == environmentId }) {
            return found
        }
        return nil
    }

    /// `http://<host>:<port>` for an announced server. The announced port is the Studio wire's.
    static func serverURL(for service: DiscoveredService) -> URL? {
        var components = URLComponents()
        components.scheme = "http"
        components.host = service.host
        components.port = Int(service.port)
        return components.url
    }

    /// Watches a browser until `record`'s server shows up, then returns its
    /// address. Returns nil when the task is cancelled first. The caller owns
    /// the browser's start and stop. Runs on the main actor, where the browser
    /// publishes what it finds.
    @MainActor
    static func waitForAddress(of record: StudioServerRecord, browser: BonjourBrowser, pollSeconds: Double = 2) async -> URL? {
        DiagnosticLog.log("studio discovery: looking for a paired server's address", tag: "studio.discovery", fields: [
            "client_id": record.clientId, "has_machine_id": String(record.machineId != nil),
            "has_environment_id": String(record.environmentId != nil)
        ])
        // Logged once per distinct candidate set, not per poll: a browse that
        // sees nothing and a browse that sees the wrong server are different
        // failures, and only this tells them apart.
        var lastReported = ""
        while !Task.isCancelled {
            let services = browser.discoveredHosts
            if let service = match(for: record, in: services), let url = serverURL(for: service) {
                DiagnosticLog.log("studio discovery: paired server found on this network", tag: "studio.discovery", fields: [
                    "client_id": record.clientId, "host": service.host, "port": String(service.port)
                ])
                return url
            }
            let candidates = services.map { "\($0.name)/\($0.metadata["machine"] ?? "-")" }.sorted().joined(separator: ",")
            if candidates != lastReported {
                lastReported = candidates
                if services.isEmpty {
                    DiagnosticLog.log("studio discovery: nothing is announcing on this network yet", tag: "studio.discovery", level: .info, fields: [
                        "client_id": record.clientId
                    ])
                } else {
                    DiagnosticLog.log("studio discovery: servers announced but none is the paired one", tag: "studio.discovery", level: .warn, fields: [
                        "client_id": record.clientId,
                        "want_machine": record.machineId ?? "-",
                        "want_environment": record.environmentId ?? "-",
                        "saw": candidates
                    ])
                }
            }
            do {
                try await Task.sleep(for: .seconds(pollSeconds))
            } catch {
                // Cancelled by the owner: the connection was stopped or the address arrived another way.
                break
            }
        }
        DiagnosticLog.log("studio discovery: stopped before the server was seen", tag: "studio.discovery", level: .debug, fields: [
            "client_id": record.clientId
        ])
        return nil
    }
}

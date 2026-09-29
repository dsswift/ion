import Foundation

/// Writes what a live connection learns about its server back to the stored record.
enum StudioServerRecordUpdater {

    /// Stores the relays, environment id, and label a welcome reported, when they changed.
    static func apply(welcome: StudioWelcome, clientId: String, store: any StudioServerStoring) {
        update(clientId: clientId, store: store, what: "welcome") { record in
            if let relays = welcome.relays { record.relays = relays }
            if let addresses = welcome.directAddresses { record.directAddresses = addresses }
            record.environmentId = welcome.environmentId
            if !welcome.label.isEmpty { record.label = welcome.label }
        }
    }

    /// Stores a newly discovered address.
    static func apply(url: URL, clientId: String, store: any StudioServerStoring) {
        update(clientId: clientId, store: store, what: "address") { $0.url = url.absoluteString }
    }

    private static func update(clientId: String, store: any StudioServerStoring, what: String, _ change: (inout StudioServerRecord) -> Void) {
        do {
            var records = try store.load()
            guard let index = records.firstIndex(where: { $0.clientId == clientId }) else {
                DiagnosticLog.log("studio record: no stored record to update", tag: "studio.store", level: .warn, fields: [
                    "client_id": clientId, "what": what
                ])
                return
            }
            let before = records[index]
            change(&records[index])
            guard records[index] != before else {
                DiagnosticLog.log("studio record: unchanged", tag: "studio.store", level: .debug, fields: [
                    "client_id": clientId, "what": what
                ])
                return
            }
            try store.save(records)
            DiagnosticLog.log("studio record: updated", tag: "studio.store", fields: [
                "client_id": clientId, "what": what, "relay_count": String(records[index].relays.count),
                "has_url": String(records[index].url != nil)
            ])
        } catch {
            DiagnosticLog.log("studio record: update failed", tag: "studio.store", level: .error, fields: [
                "client_id": clientId, "what": what, "error": String(describing: error)
            ])
        }
    }
}

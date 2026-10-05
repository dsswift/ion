import Foundation

/// Finds the pairings a newer pairing to the same server has replaced.
///
/// Two pairings whose records name one environment are one server paired
/// twice. Only the newest is kept; the older ones are stale.
enum SupersededPairings {

    struct Stale: Equatable {
        /// The `PairedDevice.id` of the replaced pairing.
        let deviceId: String
        /// The `StudioServerRecord.clientId` of the replaced pairing.
        let clientId: String
        /// The `PairedDevice.id` of the pairing that replaced it.
        let keptDeviceId: String
    }

    /// The stale pairings among `devices`, in list order. A device with no
    /// record, or whose record names no environment, is never stale and never
    /// replaces another. Of two pairings made at the same instant, the later
    /// one in the list is kept.
    static func find(devices: [PairedDevice], records: [StudioServerRecord]) -> [Stale] {
        var newest: [String: PairedDevice] = [:]
        var paired: [(device: PairedDevice, record: StudioServerRecord, environmentId: String)] = []
        for device in devices {
            guard let record = StudioServerRecord.record(for: device, in: records),
                  let environmentId = record.environmentId, !environmentId.isEmpty else { continue }
            paired.append((device, record, environmentId))
            if let current = newest[environmentId], current.pairedAt > device.pairedAt { continue }
            newest[environmentId] = device
        }
        return paired.compactMap { entry in
            guard let kept = newest[entry.environmentId], kept.id != entry.device.id else { return nil }
            return Stale(deviceId: entry.device.id, clientId: entry.record.clientId, keptDeviceId: kept.id)
        }
    }
}

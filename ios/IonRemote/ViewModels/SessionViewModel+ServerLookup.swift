import Foundation

extension SessionViewModel {

    /// The pairing whose Studio credential names `serverId` (the server's
    /// `clientId`), or nil when no pairing does.
    func pairedDevice(serverId: String) -> PairedDevice? {
        pairedDevices.first { studioRecord(for: $0)?.clientId == serverId }
    }
}

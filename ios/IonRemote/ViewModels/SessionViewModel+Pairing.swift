import Foundation
import SwiftUI

// MARK: - Pairing

extension SessionViewModel {

    func startPairing() {
        pairingState = .discovering
        pairingBrowser.startBrowsing()
    }

    func cancelPairing() {
        pairingBrowser.stopBrowsing()
        pairingState = .idle
    }

    // MARK: - Helpers

    /// Add a new device or update an existing one (dedup by id).
    /// Not private: `SessionViewModel+RelayPairing.swift` (child 19 relay
    /// pairing) shares the same dedup-by-id insertion logic.
    func addOrUpdateDevice(_ device: PairedDevice) {
        if let idx = pairedDevices.firstIndex(where: { $0.id == device.id }) {
            pairedDevices[idx] = device
        } else {
            pairedDevices.append(device)
        }
    }
}

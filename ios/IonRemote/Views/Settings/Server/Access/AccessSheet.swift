import Foundation

/// The sheets the Paired devices section opens.
enum AccessSheet: String, Identifiable {
    case pairPhone
    case pairingLink

    var id: String { rawValue }
}

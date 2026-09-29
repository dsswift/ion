import Foundation

/// The sheets the Phone and relay section opens.
enum PhoneRelaySheet: String, Identifiable {
    case display
    case relay

    var id: String { rawValue }
}

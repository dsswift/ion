import Foundation
import SwiftUI

/// Connection and pairing state shared by the session view model and views.
enum ConnectionState: String, Sendable {
    case disconnected
    case connecting
    case connected
    case reconnecting

    var label: String {
        switch self {
        case .disconnected: "Disconnected"
        case .connecting: "Connecting"
        case .connected: "Connected"
        case .reconnecting: "Reconnecting"
        }
    }

    var color: Color {
        switch self {
        case .disconnected: .red
        case .connecting: .yellow
        case .connected: .green
        case .reconnecting: .orange
        }
    }
}

enum PairingState: Sendable {
    case idle
    case discovering
    case connecting(hostName: String)
    case exchangingKeys
    case configuringRelay
    case paired
    case failed(Error)

    var isIdle: Bool {
        if case .idle = self { return true }
        return false
    }

    var isFailed: Bool {
        if case .failed = self { return true }
        return false
    }

    var isPaired: Bool {
        if case .paired = self { return true }
        return false
    }

    /// What went wrong, in words to put in front of a person. Nil unless the
    /// pairing failed — a sheet shows this instead of dismissing silently.
    var failureMessage: String? {
        if case .failed(let error) = self { return error.localizedDescription }
        return nil
    }

    var isConnecting: Bool {
        switch self {
        case .connecting, .exchangingKeys, .configuringRelay: true
        default: false
        }
    }
}

enum PairingError: Error, LocalizedError {
    case invalidResponse
    case rejected(String)

    var errorDescription: String? {
        switch self {
        case .invalidResponse: "Invalid pairing response"
        case .rejected(let reason): "Pairing rejected: \(reason)"
        }
    }
}

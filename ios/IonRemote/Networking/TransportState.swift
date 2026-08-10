import Foundation

// MARK: - TransportState

/// Current transport connectivity state.
///
/// State machine:
/// - `disconnected` -> `relayOnly`: relay connects
/// - `disconnected` -> `lanPreferred`: LAN connects (LAN-only mode)
/// - `relayOnly` -> `lanPreferred`: LAN discovered and connected
/// - `lanPreferred` -> `relayOnly`: LAN lost, relay still connected
/// - any -> `disconnected`: all transports lost
///
/// Extracted from TransportManager.swift, which is at its size cap: this is a
/// standalone value type with no dependency on the manager, and one type per
/// file is the house rule.
enum TransportState: String {
    case disconnected
    case relayOnly
    case lanPreferred
}

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
/// A standalone value type with no dependency on any transport, so it lives in
/// its own file per the house rule.
enum TransportState: String {
    case disconnected
    case relayOnly
    case lanPreferred
}

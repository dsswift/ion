import Foundation
import CryptoKit

/// Result of a one-shot `set_remote_display` round-trip. Contains the value
/// the desktop has now stored (which may differ from what we sent if the
/// desktop applied LWW and rejected our write as stale).
struct RemoteDisplayAck: Sendable {
    let customName: String?
    let customIcon: String?
    let updatedAt: Date
}

enum OneShotDisplayError: LocalizedError {
    case unreachable
    case invalidRelayURL
    case timeout
    case ackMissing
    case underlying(Error)

    var errorDescription: String? {
        switch self {
        case .unreachable:      return "Server is unreachable (offline or no relay configured)."
        case .invalidRelayURL:  return "Stored relay URL is invalid."
        case .timeout:          return "Timed out waiting for the server to confirm."
        case .ackMissing:       return "Server didn't acknowledge the update."
        case .underlying(let err): return err.localizedDescription
        }
    }
}

/// A one-shot `set_remote_display` write to a paired server this session is
/// not currently connected to. The transport is a sidecar: built, started,
/// asked one question, and stopped, with the live session untouched. The wire
/// half lives in `OneShotDisplayCommand+StudioWire.swift`.
///
/// **Important**: this helper never queues writes for later delivery. If
/// the server is offline we fail fast (per the plan's explicit decision to
/// avoid the offline-edit-replay rabbit hole).
enum OneShotDisplayCommand {

    /// Default time we'll wait for the server to ack a one-shot write.
    static let ackTimeout: Duration = .seconds(8)

    /// Time we'll wait for the transport itself to come up before declaring
    /// the server unreachable. Short enough to fail fast on truly-offline
    /// peers; long enough to absorb a slow relay handshake.
    static let connectTimeout: Duration = .seconds(6)
}

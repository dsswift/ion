import Foundation

/// Pure authority policy for server-owned data.
///
/// No time heuristic participates. A server snapshot is proof of currently
/// authenticated access; explicit cancellation/rejection is proof that cached
/// server data must not be shown. Transport loss alone is not either.
/// ADR-026 owns this boundary.
enum ServerAccessPolicy {
    static func normalizedForLaunch(_ record: ServerAccessRecord?) -> ServerAccessRecord {
        guard var record else { return .startup() }
        switch record.status {
        case .authorized, .verifying:
            record.status = .transientlyDisconnected
            record.reason = .none
            record.changedAt = Date()
        default:
            break
        }
        return record
    }

    static func mayViewServerData(_ record: ServerAccessRecord?) -> Bool {
        switch (record ?? .startup()).status {
        case .startup, .authorized, .verifying, .transientlyDisconnected:
            return true
        case .authenticationRequired, .rejected:
            return false
        }
    }

    static func mayNavigate(_ record: ServerAccessRecord?) -> Bool {
        mayViewServerData(record)
    }

    static func mayMutate(_ record: ServerAccessRecord?) -> Bool {
        record?.status == .authorized
    }

    static func isVerifying(_ record: ServerAccessRecord?) -> Bool {
        record?.status == .verifying
    }

    static func recoveryTitle(for record: ServerAccessRecord?) -> String {
        switch (record ?? .startup()).reason {
        case .wrongAccount: return "Wrong account for this server"
        case .pairingRejected: return "Pairing rejected by this server"
        case .signedOut: return "Sign-in required"
        case .userCancelled: return "Sign-in cancelled"
        case .refreshRejected: return "Sign-in required"
        case .noCredential: return "Sign-in required"
        case .none: return "Authentication required"
        }
    }

    static func recoveryMessage(for record: ServerAccessRecord?) -> String {
        switch (record ?? .startup()).reason {
        case .wrongAccount:
            return "This server's relay channel belongs to a different account. Cached server data is hidden until you sign in with the account that owns it."
        case .pairingRejected:
            return "This server no longer accepts this pairing. Cached data is hidden until you pair again."
        case .signedOut:
            return "You signed out of this server. Cached server data is hidden until access is restored."
        case .userCancelled:
            return "Authentication was cancelled. Cached server data is hidden until access is restored."
        case .refreshRejected, .noCredential:
            return "This server needs authentication. Cached server data is hidden until access is restored."
        case .none:
            return "Cached server data is hidden until this server proves authenticated access."
        }
    }
}

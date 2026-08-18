import Foundation

/// Pure authority policy for desktop-owned data.
///
/// No time heuristic participates. A desktop snapshot is proof of currently
/// authenticated access; explicit cancellation/rejection is proof that cached
/// desktop data must not be shown. Transport loss alone is not either.
/// ADR-026 owns this boundary.
enum DesktopAccessPolicy {
    static func normalizedForLaunch(_ record: DesktopAccessRecord?) -> DesktopAccessRecord {
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

    static func mayViewDesktopData(_ record: DesktopAccessRecord?) -> Bool {
        switch (record ?? .startup()).status {
        case .startup, .authorized, .verifying, .transientlyDisconnected:
            return true
        case .authenticationRequired, .rejected:
            return false
        }
    }

    static func mayNavigate(_ record: DesktopAccessRecord?) -> Bool {
        mayViewDesktopData(record)
    }

    static func mayMutate(_ record: DesktopAccessRecord?) -> Bool {
        record?.status == .authorized
    }

    static func isVerifying(_ record: DesktopAccessRecord?) -> Bool {
        record?.status == .verifying
    }

    static func recoveryTitle(for record: DesktopAccessRecord?) -> String {
        switch (record ?? .startup()).reason {
        case .wrongAccount: return "Wrong account for this desktop"
        case .pairingRejected: return "Pairing rejected by this desktop"
        case .signedOut: return "Sign-in required"
        case .userCancelled: return "Sign-in cancelled"
        case .refreshRejected: return "Sign-in required"
        case .noCredential: return "Sign-in required"
        case .none: return "Authentication required"
        }
    }

    static func recoveryMessage(for record: DesktopAccessRecord?) -> String {
        switch (record ?? .startup()).reason {
        case .wrongAccount:
            return "This desktop's relay channel belongs to a different account. Cached desktop data is hidden until you sign in with the account that owns it."
        case .pairingRejected:
            return "This desktop no longer accepts this pairing. Cached desktop data is hidden until you repair or pair again."
        case .signedOut:
            return "You signed out of this desktop. Cached desktop data is hidden until access is restored."
        case .userCancelled:
            return "Authentication was cancelled. Cached desktop data is hidden until access is restored."
        case .refreshRejected, .noCredential:
            return "This desktop needs authentication. Cached desktop data is hidden until access is restored."
        case .none:
            return "Cached desktop data is hidden until this desktop proves authenticated access."
        }
    }
}

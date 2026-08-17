import Foundation

/// Outcome of a LAN auth handshake (`TransportManager.startLANWithAuth`).
///
/// Distinguishes a **definitive rejection** (the desktop actively refused this
/// device's identity) from a **transient failure** (the socket dropped before
/// the desktop delivered any verdict). Callers must treat the two differently:
/// a rejection means the pairing is invalid (route to the pairing screen); a
/// transient failure means retry through the normal reconnect machinery —
/// never surface it as an auth failure, and never wipe pairings over it.
///
/// Live incident this classification exists for: after a re-pair, the
/// desktop's LAN auth cooldown closed the fresh iOS socket instantly
/// (close 1008 / "Socket is not connected"). Pre-classification, that
/// transient close was indistinguishable from a real rejection, iOS flipped
/// to `.authFailed`, and the app wiped every paired device.
enum LANAuthOutcome: Equatable, Sendable {
    /// `auth_result` with `success: true` received — connected.
    case success
    /// The desktop actively refused this identity: an explicit `auth_result`
    /// with `success: false`, or an application close code (4000–4999, e.g.
    /// 4003 "unknown device" / "device removed").
    case rejected
    /// The desktop KNOWS this device but cannot use its stored pairing secret
    /// (close 4004). The fault is on the desktop side — typically its OS
    /// keychain grant was lost across a reinstall, leaving the stored secret
    /// undecryptable — and it is self-repairable: the desktop still holds this
    /// phone's `mobileDeviceId`, so a codeless recovery re-pair over the LAN
    /// restores the connection with no PIN and no user action.
    ///
    /// Deliberately NOT folded into `.rejected`: that path locks the desktop
    /// and sends the user to the pairing screen, which would demand manual
    /// re-pairing for a fault the two devices can resolve between themselves.
    case secretUnusable
    /// No verdict from the desktop: socket error, auth-cooldown close (1008),
    /// the auth timeout, or the stream ending without an `auth_result`.
    case transient

    /// Application close code for "known device, unusable stored secret".
    /// Mirrors `LAN_CLOSE_SECRET_UNUSABLE` in the desktop's
    /// `protocol-envelope.ts` — lockstep wire constant.
    static let closeCodeSecretUnusable = 4004

    /// Combine the auth-stream outcome with the WebSocket close code observed
    /// when the socket dropped.
    ///
    /// The stream outcome alone cannot see *why* a connection died — the
    /// `for await` just ends. The close code disambiguates: the desktop uses
    /// application codes 4000–4999 for identity-level refusals (4003 =
    /// unknown/removed device, 4004 = known device with an unusable stored
    /// secret), which are definitive even without an `auth_result` frame.
    /// Policy/protocol closes (1008 auth cooldown) and plain socket failures
    /// (no close frame at all → `nil`) carry no verdict and stay transient.
    ///
    /// 4004 is checked before the generic 4000–4999 rejection band, and it
    /// also overrides an explicit `auth_result success=false` — the desktop
    /// sends both (the frame, then the close), and the close code carries the
    /// more specific reason.
    ///
    /// - Parameters:
    ///   - streamOutcome: what the auth message loop concluded (`.success`,
    ///     `.rejected` on explicit `auth_result success=false`, `.transient`
    ///     when the stream ended verdict-less or the timeout fired).
    ///   - closeCode: raw WebSocket close code from the dropped socket, or
    ///     `nil` when the connection failed without a close frame.
    static func resolve(streamOutcome: LANAuthOutcome, closeCode: Int?) -> LANAuthOutcome {
        if closeCode == closeCodeSecretUnusable {
            return .secretUnusable
        }
        switch streamOutcome {
        case .success:
            return .success
        case .rejected:
            return .rejected
        case .secretUnusable:
            return .secretUnusable
        case .transient:
            if let code = closeCode, (4000...4999).contains(code) {
                return .rejected
            }
            return .transient
        }
    }

    /// Parse an inbound LAN auth frame for an `auth_result` verdict.
    ///
    /// Handles both shapes the desktop emits: a bare `auth_result` object and
    /// an `auth_result` wrapped in a `WireMessage` `payload` string.
    ///
    /// - Returns: `.success` / `.rejected` when the frame carries a verdict,
    ///   `nil` when the frame is not an `auth_result` at all.
    static func verdict(fromAuthFrame json: [String: Any]) -> LANAuthOutcome? {
        if json["type"] as? String == "auth_result" {
            return json["success"] as? Bool == true ? .success : .rejected
        }
        // WireMessage wrapping an auth_result.
        if let payload = json["payload"] as? String,
           let inner = try? JSONSerialization.jsonObject(with: Data(payload.utf8)) as? [String: Any],
           inner["type"] as? String == "auth_result" {
            return inner["success"] as? Bool == true ? .success : .rejected
        }
        return nil
    }
}

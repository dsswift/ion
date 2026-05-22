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
        case .unreachable:      return "Desktop is unreachable (offline or no relay configured)."
        case .invalidRelayURL:  return "Stored relay URL is invalid."
        case .timeout:          return "Timed out waiting for the desktop to confirm."
        case .ackMissing:       return "Desktop didn't acknowledge the update."
        case .underlying(let err): return err.localizedDescription
        }
    }
}

/// Send a `set_remote_display` to an inactive paired desktop using a
/// transient sidecar `TransportManager`. The active session is untouched.
///
/// Flow:
///   1. Build a fresh TransportManager from the device's stored relay
///      config + shared secret. (We do NOT touch the SessionViewModel's
///      `transport` property.)
///   2. start() the transport (relay or LAN-only depending on apiKey).
///   3. Send `setRemoteDisplay(...)` after waiting briefly for the connection.
///   4. Listen on the sidecar's event stream for a `remote_display` event.
///   5. stop() the transport and return the result.
///   6. On timeout / connection failure, throw so the caller can revert
///      the optimistic local write and surface the error in the UI.
///
/// **Important**: this helper never queues writes for later delivery. If
/// the desktop is offline we fail fast (per the plan's explicit decision to
/// avoid the offline-edit-replay rabbit hole).
enum OneShotDisplayCommand {

    /// Default time we'll wait for the desktop to ack a one-shot write.
    static let ackTimeout: Duration = .seconds(8)

    /// Time we'll wait for the transport itself to come up before declaring
    /// the desktop unreachable. Short enough to fail fast on truly-offline
    /// peers; long enough to absorb a slow relay handshake.
    static let connectTimeout: Duration = .seconds(6)

    static func send(
        device: PairedDevice,
        customName: String?,
        customIcon: String?,
        updatedAt: Date,
    ) async throws -> RemoteDisplayAck {
        let updatedAtMs = Int(updatedAt.timeIntervalSince1970 * 1000)
        let deviceIdShort = device.id.prefix(8)
        DiagnosticLog.log("ONESHOT-DISPLAY: start device=\(deviceIdShort) ts=\(updatedAtMs)")

        // ── Build the transient transport ────────────────────────────────
        let sharedKey = SymmetricKey(data: device.sharedSecret)
        let effectiveRelayURL = device.relayURL ?? ""
        let effectiveAPIKey = device.relayAPIKey ?? ""

        let tm: TransportManager
        let isLANOnly: Bool
        var lanHost: String? = nil
        var lanPort: UInt16? = nil

        if effectiveAPIKey == "lan-direct" {
            // LAN-direct pairing: parse the host/port out of the relayURL.
            guard let url = URL(string: effectiveRelayURL),
                  let host = url.host(percentEncoded: false),
                  let port = url.port else {
                DiagnosticLog.log("ONESHOT-DISPLAY: invalid LAN URL device=\(deviceIdShort) url=\(effectiveRelayURL)")
                throw OneShotDisplayError.invalidRelayURL
            }
            DiagnosticLog.log("ONESHOT-DISPLAY: LAN-direct device=\(deviceIdShort) host=\(host):\(port)")
            tm = TransportManager(sharedKey: sharedKey, deviceId: device.id)
            tm.deviceName = device.name
            isLANOnly = true
            lanHost = host
            lanPort = UInt16(port)
        } else {
            guard !effectiveRelayURL.isEmpty, let url = URL(string: effectiveRelayURL) else {
                DiagnosticLog.log("ONESHOT-DISPLAY: invalid relay URL device=\(deviceIdShort) url=\(effectiveRelayURL)")
                throw OneShotDisplayError.invalidRelayURL
            }
            let channelId = E2ECrypto.deriveChannelId(sharedSecret: sharedKey)
            DiagnosticLog.log("ONESHOT-DISPLAY: relay device=\(deviceIdShort) url=\(effectiveRelayURL) ch=\(channelId.prefix(8))")
            tm = TransportManager(
                relayURL: url,
                apiKey: effectiveAPIKey,
                channelId: channelId,
                sharedKey: sharedKey,
                apnsToken: nil,
            )
            tm.deviceId = device.id
            tm.deviceName = device.name
            isLANOnly = false
        }

        // Guarantee teardown regardless of which branch we exit on.
        defer {
            DiagnosticLog.log("ONESHOT-DISPLAY: stop device=\(deviceIdShort)")
            tm.stop()
        }

        // ── Bring the transport up ───────────────────────────────────────
        if isLANOnly, let host = lanHost, let port = lanPort {
            let authed = await tm.startLANWithAuth(host: host, port: port)
            if !authed {
                DiagnosticLog.log("ONESHOT-DISPLAY: LAN auth failed device=\(deviceIdShort)")
                throw OneShotDisplayError.unreachable
            }
        } else {
            await tm.start()
            // Wait for the relay to become connected (the relay's WS may
            // need a moment to negotiate). Poll briefly with a hard cap.
            let deadline = ContinuousClock.now.advanced(by: connectTimeout)
            while ContinuousClock.now < deadline {
                if tm.state != .disconnected { break }
                try? await Task.sleep(for: .milliseconds(100))
            }
            if tm.state == .disconnected {
                DiagnosticLog.log("ONESHOT-DISPLAY: connect timeout device=\(deviceIdShort) state=disconnected")
                throw OneShotDisplayError.unreachable
            }
            DiagnosticLog.log("ONESHOT-DISPLAY: connected device=\(deviceIdShort) state=\(tm.state.rawValue)")
        }

        // ── Send the command and listen for the ack ──────────────────────
        // Order matters: start the listener BEFORE sending, otherwise a
        // very-fast relay round-trip could deliver `remote_display` before
        // we subscribe and we'd miss it. The AsyncStream is single-consumer
        // but tm.events buffers events until the first iterator reads.

        let command = RemoteCommand.setRemoteDisplay(
            customName: customName,
            customIcon: customIcon,
            updatedAt: updatedAt,
        )

        return try await withThrowingTaskGroup(of: RemoteDisplayAck.self) { group in
            // Ack-listener task.
            group.addTask {
                for await event in tm.events {
                    if case .remoteDisplay(let cn, let ci, let serverTs) = event {
                        let serverMs = Int(serverTs.timeIntervalSince1970 * 1000)
                        DiagnosticLog.log("ONESHOT-DISPLAY: ack device=\(deviceIdShort) name=\(cn == nil ? "cleared" : "set") icon=\(ci ?? "cleared") serverTs=\(serverMs)")
                        return RemoteDisplayAck(customName: cn, customIcon: ci, updatedAt: serverTs)
                    }
                    // Other events on this transient transport are ignored;
                    // the desktop typically also sends a heartbeat. We just
                    // wait for the one event we care about.
                }
                DiagnosticLog.log("ONESHOT-DISPLAY: event stream ended without ack device=\(deviceIdShort)")
                throw OneShotDisplayError.ackMissing
            }

            // Timeout task.
            group.addTask {
                try? await Task.sleep(for: ackTimeout)
                if Task.isCancelled { throw OneShotDisplayError.timeout }
                DiagnosticLog.log("ONESHOT-DISPLAY: timeout device=\(deviceIdShort) after=\(ackTimeout)")
                throw OneShotDisplayError.timeout
            }

            // Send the command. We do this from the parent task (not in a
            // child) so that any send error throws immediately and aborts
            // both the listener and the timeout.
            do {
                try await tm.send(command)
                DiagnosticLog.log("ONESHOT-DISPLAY: command sent device=\(deviceIdShort)")
            } catch {
                DiagnosticLog.log("ONESHOT-DISPLAY: send error device=\(deviceIdShort) err=\(error.localizedDescription)")
                group.cancelAll()
                throw OneShotDisplayError.underlying(error)
            }

            // First child to return wins.
            do {
                let ack = try await group.next()!
                group.cancelAll()
                return ack
            } catch {
                group.cancelAll()
                throw error
            }
        }
    }
}

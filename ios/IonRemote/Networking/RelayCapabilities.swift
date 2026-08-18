import Foundation

// MARK: - RelayCapabilities

/// Probes a relay's `/v1/auth/config` endpoint (unauthenticated) to discover
/// which delivery semantics the relay supports. The result determines whether
/// outbound sends wait for a `relay:forwarded` ACK (strict), fire-and-forget
/// over the socket (legacy), or whether the probe itself was unreachable.
final class RelayCapabilities: @unchecked Sendable {

    // MARK: - Types

    /// Relay delivery acknowledgment mode.
    enum AckMode: String, Sendable {
        /// Relay advertises `mobileForwardAck: true`. Sends MUST wait for
        /// `relay:forwarded` / `relay:peer-unavailable` before returning.
        case strict

        /// Relay is reachable but does NOT advertise `mobileForwardAck`.
        /// Sends complete when the socket write finishes (no ACK wait).
        case legacy

        /// Probe could not reach the relay (network error, timeout, non-200,
        /// malformed JSON). Sends use legacy behavior and no credential is
        /// locked out based on the probe result.
        case unavailable
    }

    /// Decoded response from `GET /v1/auth/config`.
    struct AuthConfig: Decodable, Sendable {
        let oidc: Bool
        let psk: Bool
        let capabilities: Capabilities?

        struct Capabilities: Decodable, Sendable {
            let mobileForwardAck: Bool?
        }
    }

    // MARK: - State

    private let lock = NSLock()
    private var _ackMode: AckMode = .unavailable
    private var _probeDate: Date?

    var ackMode: AckMode {
        lock.lock()
        defer { lock.unlock() }
        return _ackMode
    }

    var probeDate: Date? {
        lock.lock()
        defer { lock.unlock() }
        return _probeDate
    }

    // MARK: - Probe

    /// Probe the relay's `/v1/auth/config` endpoint to discover capabilities.
    /// No auth header is sent; the endpoint is unauthenticated by design.
    /// Returns the resolved `AckMode`. Timeout is 5 seconds.
    @discardableResult
    func probe(relayURL: URL) async -> AckMode {
        let config = buildProbeURL(relayURL: relayURL)
        guard let probeURL = config else {
            DiagnosticLog.log("relay capability probe: cannot build URL", tag: "relay.capabilities", level: .warn, fields: [
                "relay_url": relayURL.absoluteString
            ])
            return setMode(.unavailable)
        }

        var request = URLRequest(url: probeURL)
        request.httpMethod = "GET"
        request.timeoutInterval = 5.0

        let mode: AckMode
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                DiagnosticLog.log("relay capability probe: non-HTTP response", tag: "relay.capabilities", level: .warn, fields: [:])
                return setMode(.unavailable)
            }
            guard http.statusCode == 200 else {
                DiagnosticLog.log("relay capability probe: non-200", tag: "relay.capabilities", level: .warn, fields: [
                    "status": String(http.statusCode)
                ])
                return setMode(.unavailable)
            }
            let authConfig = try JSONDecoder().decode(AuthConfig.self, from: data)
            let ack = authConfig.capabilities?.mobileForwardAck ?? false
            mode = ack ? .strict : .legacy

            DiagnosticLog.log("relay capability probe ok", tag: "relay.capabilities", fields: [
                "ack_mode": mode.rawValue,
                "oidc": String(authConfig.oidc),
                "psk": String(authConfig.psk)
            ])
        } catch {
            DiagnosticLog.log("relay capability probe failed", tag: "relay.capabilities", level: .warn, fields: [
                "error": error.localizedDescription
            ])
            mode = .unavailable
        }

        return setMode(mode)
    }

    /// Reset to unavailable (called on transport teardown).
    func reset() {
        lock.lock()
        _ackMode = .unavailable
        _probeDate = nil
        lock.unlock()
    }

    // MARK: - Internals

    private func setMode(_ mode: AckMode) -> AckMode {
        lock.lock()
        _ackMode = mode
        _probeDate = Date()
        lock.unlock()
        return mode
    }

    func buildProbeURL(relayURL: URL) -> URL? {
        var components = URLComponents()
        switch relayURL.scheme {
        case "wss", "https": components.scheme = "https"
        default:             components.scheme = "http"
        }
        components.host = relayURL.host(percentEncoded: false)
        components.port = relayURL.port
        let basePath = relayURL.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        components.path = basePath.isEmpty
            ? "/v1/auth/config"
            : "/\(basePath)/v1/auth/config"
        return components.url
    }
}

import Foundation

// MARK: - ServerAuthConfig

/// The OIDC configuration a server advertises for direct connections.
///
/// Mirrors the server's `GET /auth/config` response (Ion Studio Server, child
/// 09/19). A server with no OIDC configured either omits the endpoint (404) or
/// answers with `{"oidc": null}` — both decode to `nil` here, and the caller
/// falls back to the manual Advanced-disclosure entry (issuer/audience/scope
/// typed by the operator) so a server this client has never talked to can
/// still be paired directly.
struct ServerAuthConfig: Codable, Sendable, Equatable {
    let issuer: String
    let audience: String
    let scope: String

    private enum CodingKeys: String, CodingKey {
        case issuer, audience, scope
    }
}

/// Wire envelope for `GET /auth/config`. The server may answer with no `oidc`
/// key at all (personal / non-enterprise server) — `oidc` decodes nil in that
/// case, which is a valid, successful response, not a fetch failure.
private struct ServerAuthConfigResponse: Codable {
    let oidc: ServerAuthConfig?
}

enum ServerAuthConfigError: Error, LocalizedError {
    case invalidURL
    case httpFailure(Int)
    case decodingFailed

    var errorDescription: String? {
        switch self {
        case .invalidURL: return "Malformed server URL"
        case .httpFailure(let status): return "Server auth config request failed (HTTP \(status))"
        case .decodingFailed: return "Server auth config response was not valid JSON"
        }
    }
}

/// Client for a server's `GET /auth/config` endpoint. Used by the direct-
/// connection and relay-pairing flows to discover whether a server requires
/// an OIDC bearer token before the first `desktop_auth` message can be built.
enum ServerAuthConfigClient {

    /// Fetch `<baseURL>/auth/config`. `baseURL` may be an `http(s)://` or
    /// `ws(s)://` origin — the scheme is normalized to `http(s)` for the
    /// plain HTTP GET regardless of what the caller passed (the same host
    /// is later dialed as `wss://` for the WebSocket upgrade).
    ///
    /// Returns `nil` — NOT a thrown error — when the server has no OIDC
    /// configured (a valid, successful response with `oidc: null`, or a 404,
    /// which many servers use for "no such endpoint" on a personal/dev
    /// deployment). Throws only on a genuine transport or decode failure, so
    /// the caller can distinguish "ask the user for manual issuer/audience/
    /// scope because we couldn't reach the endpoint at all" from "this
    /// server doesn't need OIDC."
    static func fetch(baseURL: URL) async throws -> ServerAuthConfig? {
        guard let url = Self.authConfigURL(for: baseURL) else {
            DiagnosticLog.log("server auth config: malformed base URL", tag: "auth.config", level: .warn, fields: [
                "base_url": baseURL.absoluteString
            ])
            throw ServerAuthConfigError.invalidURL
        }

        DiagnosticLog.log("server auth config: fetching", tag: "auth.config", fields: [
            "host": url.host(percentEncoded: false) ?? "unknown"
        ])

        let (data, response) = try await URLSession.shared.data(from: url)
        guard let http = response as? HTTPURLResponse else {
            throw ServerAuthConfigError.decodingFailed
        }
        if http.statusCode == 404 {
            // No auth-config endpoint at all — treat as "no OIDC advertised",
            // not a failure. This lets a personal/dev server (no enterprise
            // gateway in front of it) pair directly with no manual entry.
            DiagnosticLog.log("server auth config: endpoint not found, no OIDC advertised", tag: "auth.config", fields: [
                "host": url.host(percentEncoded: false) ?? "unknown"
            ])
            return nil
        }
        guard (200..<300).contains(http.statusCode) else {
            DiagnosticLog.log("server auth config: HTTP failure", tag: "auth.config", level: .warn, fields: [
                "host": url.host(percentEncoded: false) ?? "unknown",
                "status": String(http.statusCode)
            ])
            throw ServerAuthConfigError.httpFailure(http.statusCode)
        }
        // The else branch logs the decode failure and throws decodingFailed.
        // swiftlint:disable:next silent_try_optional
        guard let decoded = try? JSONDecoder().decode(ServerAuthConfigResponse.self, from: data) else {
            DiagnosticLog.log("server auth config: decode failed", tag: "auth.config", level: .warn, fields: [
                "host": url.host(percentEncoded: false) ?? "unknown",
                "bytes": String(data.count)
            ])
            throw ServerAuthConfigError.decodingFailed
        }
        DiagnosticLog.log("server auth config: fetched", tag: "auth.config", fields: [
            "host": url.host(percentEncoded: false) ?? "unknown",
            "has_oidc": String(decoded.oidc != nil)
        ])
        return decoded.oidc
    }

    /// Build the `/auth/config` URL from a server base URL, normalizing
    /// `ws(s)://` schemes to `http(s)://` for the plain HTTP GET.
    static func authConfigURL(for baseURL: URL) -> URL? {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        switch components?.scheme {
        case "wss": components?.scheme = "https"
        case "ws": components?.scheme = "http"
        case "https", "http": break
        default: components?.scheme = "https"
        }
        components?.path = "/auth/config"
        components?.query = nil
        components?.fragment = nil
        return components?.url
    }
}

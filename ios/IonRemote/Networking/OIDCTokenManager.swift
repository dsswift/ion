import Foundation
import CryptoKit
import AuthenticationServices

// MARK: - Errors

enum OIDCTokenError: Error, LocalizedError {
    case managerUnavailable
    case interactiveCancelled
    case tokenEndpointFailed(String)
    case discoveryFailed(String)
    case missingTokenInResponse

    var errorDescription: String? {
        switch self {
        case .managerUnavailable:        return "OIDC token manager is unavailable"
        case .interactiveCancelled:      return "Interactive sign-in was cancelled"
        case .tokenEndpointFailed(let m): return "Token endpoint failed: \(m)"
        case .discoveryFailed(let m):    return "OIDC discovery failed: \(m)"
        case .missingTokenInResponse:    return "Token endpoint response missing access_token"
        }
    }
}

// MARK: - Result

struct OIDCTokenResult {
    let accessToken: String
    let refreshToken: String
    let expiry: Date
}

// MARK: - Actor

/// Manages OIDC token lifecycle for autonomous relay authentication.
///
/// Three-tier: in-memory cache -> silent refresh (Keychain refresh token) ->
/// interactive PKCE (ASWebAuthenticationSession). Called by RelayClient when
/// a bearer token is needed for the relay WebSocket connection.
actor OIDCTokenManager {

    // Configuration is nonisolated-readable (immutable lets on an actor are
    // cross-actor accessible for Sendable types). SessionViewModel compares
    // these against an incoming relay_config to decide whether the existing
    // manager can be kept — replacing the manager discards the single-flight
    // guard and the post-cancel cooldown, which re-opens the "stacked sign-in
    // sheets" defect.
    let clientId: String
    let issuer: String
    let scope: String
    let deviceId: String

    /// Composed Keychain service key for the refresh token.
    private var keychainKey: String { "com.ion.oidc.refresh.\(deviceId)" }

    /// Cached access token and its expiry. Nil when not yet acquired or invalidated.
    private var cachedToken: String?
    private var cachedExpiry: Date?

    /// Cached OIDC discovery endpoints (fetched once per manager instance).
    private var discoveredAuth: URL?
    private var discoveredToken: URL?

    /// Single-flight guard: the currently running token acquisition, if any.
    /// RelayClient's reconnect/backoff loop calls accessToken() on every
    /// attempt; without this, each retry that reaches tier 3 stacks another
    /// ASWebAuthenticationSession sheet on top of the user's in-progress
    /// sign-in (new prompts appearing mid-flow every backoff interval).
    /// All concurrent callers await the same in-flight task and share its
    /// result or error.
    private var inFlightAcquisition: Task<String, Error>?

    /// When the user explicitly cancelled the interactive sign-in sheet,
    /// suppress re-launching it until this time. Without the cooldown the
    /// next reconnect attempt (seconds later) immediately re-prompts —
    /// dismiss, prompt, dismiss, prompt. Silent refresh is NOT suppressed;
    /// only the user-facing browser sheet is.
    private var interactiveCooldownUntil: Date = .distantPast

    /// How long to wait after a user cancel before offering the sheet again.
    private static let interactiveCancelCooldownSeconds: TimeInterval = 300

    /// Minimum seconds before expiry to consider token still valid (2 minutes).
    private static let expiryLeadSeconds: TimeInterval = 120

    init(clientId: String, issuer: String, scope: String, deviceId: String) {
        self.clientId = clientId
        self.issuer = issuer
        self.scope = scope
        self.deviceId = deviceId
    }

    // MARK: - Public API

    /// Returns a valid access token. Three-tier: cache -> silent refresh -> interactive.
    /// Throws OIDCTokenError on unrecoverable failure.
    ///
    /// Single-flight: when an acquisition is already running (e.g. the user
    /// is mid-sign-in in the browser sheet), concurrent callers await that
    /// same acquisition instead of starting a parallel one. This is what
    /// prevents the reconnect/backoff loop from stacking repeated sign-in
    /// prompts on top of an in-progress flow.
    func accessToken() async throws -> String {
        // Tier 1: cache hit — fast path, no single-flight needed.
        if let token = cachedToken, let expiry = cachedExpiry,
           expiry.timeIntervalSinceNow > Self.expiryLeadSeconds {
            DiagnosticLog.log("oidc: returning cached token", tag: "oidc.token", fields: [
                "expires_in_s": String(Int(expiry.timeIntervalSinceNow))
            ])
            return token
        }

        // Join an in-flight acquisition rather than starting a second one.
        if let inFlight = inFlightAcquisition {
            DiagnosticLog.log("oidc: joining in-flight token acquisition", tag: "oidc.token")
            return try await inFlight.value
        }

        let task = Task<String, Error> { try await self.acquireToken() }
        inFlightAcquisition = task
        defer { inFlightAcquisition = nil }
        return try await task.value
    }

    /// The actual tier 2 (silent refresh) / tier 3 (interactive) acquisition.
    /// Runs at most once concurrently — guarded by inFlightAcquisition.
    private func acquireToken() async throws -> String {
        // Tier 2: silent refresh
        if let refreshToken = KeychainHelper.get(keychainKey) {
            DiagnosticLog.log("oidc: attempting silent refresh", tag: "oidc.token")
            do {
                let endpoints = try await discoverEndpoints()
                let result = try await silentRefresh(refreshToken: refreshToken, tokenEndpoint: endpoints.tokenEndpoint)
                cachedToken = result.accessToken
                cachedExpiry = result.expiry
                DiagnosticLog.log("oidc: silent refresh succeeded", tag: "oidc.token", fields: [
                    "expires_in_s": String(Int(result.expiry.timeIntervalSinceNow))
                ])
                return result.accessToken
            } catch {
                DiagnosticLog.log("oidc: silent refresh failed, escalating to interactive", tag: "oidc.token", level: .warn, fields: [
                    "error": error.localizedDescription
                ])
                // Clear stale refresh token if it caused auth failure
                if case OIDCTokenError.tokenEndpointFailed = error {
                    KeychainHelper.delete(keychainKey)
                }
            }
        }

        // Tier 3: interactive PKCE
        // Respect the post-cancel cooldown: if the user just dismissed the
        // sheet, don't shove it back in their face on the next reconnect tick.
        if Date() < interactiveCooldownUntil {
            DiagnosticLog.log("oidc: interactive sign-in suppressed (user-cancel cooldown)", tag: "oidc.token", fields: [
                "cooldown_remaining_s": String(Int(interactiveCooldownUntil.timeIntervalSinceNow))
            ])
            throw OIDCTokenError.interactiveCancelled
        }
        DiagnosticLog.log("oidc: launching interactive sign-in", tag: "oidc.token", level: .warn)
        let endpoints = try await discoverEndpoints()
        do {
            let result = try await interactiveSignIn(authEndpoint: endpoints.authorizationEndpoint, tokenEndpoint: endpoints.tokenEndpoint)
            cachedToken = result.accessToken
            cachedExpiry = result.expiry
            DiagnosticLog.log("oidc: interactive sign-in succeeded", tag: "oidc.token", fields: [
                "expires_in_s": String(Int(result.expiry.timeIntervalSinceNow))
            ])
            return result.accessToken
        } catch OIDCTokenError.interactiveCancelled {
            // User explicitly dismissed the sheet — back off before asking again.
            interactiveCooldownUntil = Date().addingTimeInterval(Self.interactiveCancelCooldownSeconds)
            DiagnosticLog.log("oidc: user cancelled sign-in, cooldown started", tag: "oidc.token", fields: [
                "cooldown_s": String(Int(Self.interactiveCancelCooldownSeconds))
            ])
            throw OIDCTokenError.interactiveCancelled
        }
    }

    /// Invalidates the in-memory cached token. Called by RelayClient on 4401.
    /// The next accessToken() call will attempt silent refresh before falling
    /// back to interactive.
    func invalidateAccessToken() {
        DiagnosticLog.log("oidc: access token invalidated (4401 received)", tag: "oidc.token")
        cachedToken = nil
        cachedExpiry = nil
    }

    // MARK: - Discovery

    private func discoverEndpoints() async throws -> (authorizationEndpoint: URL, tokenEndpoint: URL) {
        if let auth = discoveredAuth, let token = discoveredToken {
            return (auth, token)
        }
        guard let discoveryURL = URL(string: issuer.trimmingCharacters(in: .init(charactersIn: "/")) + "/.well-known/openid-configuration") else {
            // issuer arrives over the wire; a malformed value must throw, not crash.
            throw OIDCTokenError.discoveryFailed("malformed issuer URL")
        }
        let (data, response) = try await URLSession.shared.data(from: discoveryURL)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw OIDCTokenError.discoveryFailed("HTTP \((response as? HTTPURLResponse)?.statusCode ?? -1)")
        }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let authStr = json["authorization_endpoint"] as? String,
              let tokenStr = json["token_endpoint"] as? String,
              let authURL = URL(string: authStr),
              let tokenURL = URL(string: tokenStr) else {
            throw OIDCTokenError.discoveryFailed("missing authorization_endpoint or token_endpoint")
        }
        discoveredAuth = authURL
        discoveredToken = tokenURL
        return (authURL, tokenURL)
    }

    // MARK: - Silent Refresh

    private func silentRefresh(refreshToken: String, tokenEndpoint: URL) async throws -> OIDCTokenResult {
        var request = URLRequest(url: tokenEndpoint)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        let body = [
            "grant_type=refresh_token",
            "client_id=\(clientId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? clientId)",
            "scope=\(scope.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? scope)",
            "refresh_token=\(refreshToken.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? refreshToken)",
        ].joined(separator: "&")
        request.httpBody = body.data(using: .utf8)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw OIDCTokenError.tokenEndpointFailed("no HTTP response")
        }
        guard http.statusCode == 200 else {
            let body = String(data: data, encoding: .utf8) ?? "unknown"
            throw OIDCTokenError.tokenEndpointFailed("HTTP \(http.statusCode): \(body.prefix(200))")
        }
        return try parseTokenResponse(data: data)
    }

    // MARK: - Interactive PKCE

    @MainActor
    private func interactiveSignIn(authEndpoint: URL, tokenEndpoint: URL) async throws -> OIDCTokenResult {
        // Generate PKCE code verifier (43 random URL-safe base64 chars)
        var verifierBytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, verifierBytes.count, &verifierBytes)
        let codeVerifier = Data(verifierBytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")

        // Code challenge = BASE64URL(SHA256(verifier))
        let challengeData = SHA256.hash(data: Data(codeVerifier.utf8))
        let codeChallenge = Data(challengeData).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")

        let state = UUID().uuidString
        let redirectURI = "ionremote://auth"
        let fullScope = "openid offline_access \(scope)"

        guard var components = URLComponents(url: authEndpoint, resolvingAgainstBaseURL: false) else {
            // authEndpoint originates from discovery (wire-derived); a value that
            // cannot be parsed into components must throw, not crash.
            throw OIDCTokenError.discoveryFailed("malformed authorization endpoint")
        }
        components.queryItems = [
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "client_id", value: clientId),
            URLQueryItem(name: "redirect_uri", value: redirectURI),
            URLQueryItem(name: "scope", value: fullScope),
            URLQueryItem(name: "code_challenge", value: codeChallenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "state", value: state),
            // Force the account picker. prefersEphemeralWebBrowserSession=false
            // shares Safari's Entra session for SSO convenience, but silent SSO
            // picks whichever account Safari holds — often a work account from
            // a different tenant, which fails with AADSTS50020 ("account does
            // not exist in tenant"). select_account keeps the SSO cookie (the
            // right account is one tap, no password) while letting the user
            // choose when Safari's default account is the wrong one.
            URLQueryItem(name: "prompt", value: "select_account"),
        ]
        guard let authURL = components.url else {
            throw OIDCTokenError.discoveryFailed("could not build authorization URL")
        }

        // Run ASWebAuthenticationSession
        let callbackURL: URL = try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: authURL, callbackURLScheme: "ionremote") { url, error in
                if let error = error {
                    let asError = error as? ASWebAuthenticationSessionError
                    if asError?.code == .canceledLogin {
                        continuation.resume(throwing: OIDCTokenError.interactiveCancelled)
                    } else {
                        continuation.resume(throwing: OIDCTokenError.tokenEndpointFailed(error.localizedDescription))
                    }
                    return
                }
                guard let url else {
                    continuation.resume(throwing: OIDCTokenError.tokenEndpointFailed("no callback URL"))
                    return
                }
                continuation.resume(returning: url)
            }
            session.prefersEphemeralWebBrowserSession = false
            session.presentationContextProvider = ASWebAuthenticationPresentationContext.shared
            session.start()
        }

        // Extract authorization code
        guard let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false),
              let code = components.queryItems?.first(where: { $0.name == "code" })?.value else {
            throw OIDCTokenError.tokenEndpointFailed("no code in callback URL")
        }

        // Exchange code for tokens
        var tokenRequest = URLRequest(url: tokenEndpoint)
        tokenRequest.httpMethod = "POST"
        tokenRequest.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        let body = [
            "grant_type=authorization_code",
            "client_id=\(clientId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? clientId)",
            "redirect_uri=\(redirectURI.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? redirectURI)",
            "code=\(code.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? code)",
            "code_verifier=\(codeVerifier.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? codeVerifier)",
        ].joined(separator: "&")
        tokenRequest.httpBody = body.data(using: .utf8)

        let (data, response) = try await URLSession.shared.data(for: tokenRequest)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let body = String(data: data, encoding: .utf8) ?? "unknown"
            throw OIDCTokenError.tokenEndpointFailed("HTTP \((response as? HTTPURLResponse)?.statusCode ?? -1): \(body.prefix(200))")
        }
        let result = try parseTokenResponse(data: data)
        // parseTokenResponse already persisted the refresh token to Keychain
        // (it is the single persistence point, shared with silentRefresh's
        // rotation). No second write here.
        return result
    }

    // MARK: - Token Response Parsing

    nonisolated private func parseTokenResponse(data: Data) throws -> OIDCTokenResult {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let accessToken = json["access_token"] as? String,
              let refreshToken = json["refresh_token"] as? String else {
            throw OIDCTokenError.missingTokenInResponse
        }
        let expiresIn = (json["expires_in"] as? TimeInterval) ?? 3600
        let expiry = Date().addingTimeInterval(expiresIn)
        // Persist refresh token (also called from silentRefresh to rotate)
        KeychainHelper.set(refreshToken, service: "com.ion.oidc.refresh.\(deviceId)")
        return OIDCTokenResult(accessToken: accessToken, refreshToken: refreshToken, expiry: expiry)
    }
}

// MARK: - ASWebAuthentication Presentation Context

/// Singleton presentation context for ASWebAuthenticationSession.
/// Provides the key window as the anchor for the authentication web view.
private final class ASWebAuthenticationPresentationContext: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = ASWebAuthenticationPresentationContext()

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first(where: { $0.isKeyWindow }) ?? ASPresentationAnchor()
    }
}

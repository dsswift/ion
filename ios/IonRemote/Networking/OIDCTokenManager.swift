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
    case randomGenerationFailed
    case callbackStateMismatch
    /// Token endpoint rejected the durable authorization grant. Retrying the
    /// same refresh token cannot succeed; caller must request interaction.
    case refreshGrantRejected(String)
    /// show Ion's contextual preflight before it invokes interactive PKCE.
    case interactionRequired

    var errorDescription: String? {
        switch self {
        case .managerUnavailable:        return "OIDC token manager is unavailable"
        case .interactiveCancelled:      return "Interactive sign-in was cancelled"
        case .tokenEndpointFailed(let m): return "Token endpoint failed: \(m)"
        case .discoveryFailed(let m):    return "OIDC discovery failed: \(m)"
        case .missingTokenInResponse:    return "Token endpoint response missing access_token"
        case .randomGenerationFailed:    return "Could not generate secure PKCE verifier"
        case .callbackStateMismatch:     return "Authorization callback did not match request"
        case .refreshGrantRejected(let m): return "Refresh token was rejected: \(m)"
        case .interactionRequired:       return "Interactive sign-in is required"
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
///
/// **One instance per pairing.** A phone paired with desktops in different
/// identity tenants holds one manager per desktop, each with its own issuer,
/// client ID, scope, cached token, and Keychain refresh token.
/// `OIDCTokenManagerRegistry` owns their lifetimes; nothing else constructs
/// them in production code.
actor OIDCTokenManager {

    // Configuration is nonisolated-readable so it can be compared without an
    // await. OIDCTokenManagerRegistry compares these against a pairing's stored
    // config to decide whether this instance can be kept — replacing the manager
    // discards the single-flight guard and the post-cancel cooldown, which
    // re-opens the "stacked sign-in sheets" defect.
    //
    // `nonisolated` is explicit rather than inferred: an actor's immutable
    // properties are only implicitly cross-actor readable within the defining
    // module (SE-0327), and the test target reaches them through
    // `@testable import`.
    nonisolated let clientId: String
    nonisolated let issuer: String
    nonisolated let scope: String
    nonisolated let deviceId: String

    /// Composed Keychain service key for this pairing's refresh token.
    ///
    /// `static` because `parseTokenResponse` is `nonisolated` and needs the same
    /// composition: one definition, so a future rename cannot drift between the
    /// write path, the read path, and the registry's delete path.
    nonisolated static func refreshKey(deviceId: String) -> String {
        "com.ion.oidc.refresh.\(deviceId)"
    }

    /// This pairing's Keychain service key.
    private var keychainKey: String { Self.refreshKey(deviceId: deviceId) }

    /// Account behind the most recently parsed token response, for display.
    /// Nil until a token has been acquired in this process.
    private var accountIdentity: OIDCAccountIdentity?

    /// Fired whenever a token response yields an account identity, so the
    /// session layer can persist it onto the matching `PairedDevice`.
    private let onIdentity: (@Sendable (String, OIDCAccountIdentity) -> Void)?

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

    init(
        clientId: String,
        issuer: String,
        scope: String,
        deviceId: String,
        onIdentity: (@Sendable (String, OIDCAccountIdentity) -> Void)? = nil
    ) {
        self.clientId = clientId
        self.issuer = issuer
        self.scope = scope
        self.deviceId = deviceId
        self.onIdentity = onIdentity
    }

    /// Test-only initializer that seeds the in-memory token cache.
    ///
    /// Tiers 2 and 3 both require network I/O — silent refresh hits the token
    /// endpoint and interactive sign-in needs a live `ASWebAuthenticationSession`
    /// presentation context that XCTest cannot provide. Seeding tier 1 directly
    /// is what makes cache-hit, expiry-window, and invalidation behaviour
    /// testable without either.
    init(
        clientId: String,
        issuer: String,
        scope: String,
        deviceId: String,
        seedToken: String,
        seedExpiry: Date,
        onIdentity: (@Sendable (String, OIDCAccountIdentity) -> Void)? = nil
    ) {
        self.clientId = clientId
        self.issuer = issuer
        self.scope = scope
        self.deviceId = deviceId
        self.onIdentity = onIdentity
        self.cachedToken = seedToken
        self.cachedExpiry = seedExpiry
    }

    // MARK: - Public API

    /// Returns a valid token without launching browser UI. Automatic connection
    /// may refresh silently, but interaction belongs to the app-owned contextual
    /// recovery screen (ADR-027).
    func accessToken() async throws -> String {
        if let token = cachedToken, let expiry = cachedExpiry,
           expiry.timeIntervalSinceNow > Self.expiryLeadSeconds {
            return token
        }
        guard let refreshToken = KeychainHelper.get(keychainKey) else {
            throw OIDCTokenError.interactionRequired
        }
        do {
            let endpoints = try await discoverEndpoints()
            let result = try await silentRefresh(refreshToken: refreshToken, tokenEndpoint: endpoints.tokenEndpoint)
            cachedToken = result.accessToken
            cachedExpiry = result.expiry
            return result.accessToken
        } catch OIDCTokenError.refreshGrantRejected {
            // Durable grant is spent/revoked. Delete exactly this pairing's
            // credential and route user through contextual interaction.
            KeychainHelper.delete(keychainKey)
            throw OIDCTokenError.interactionRequired
        } catch {
            // Discovery/network/5xx failures are transient. RelayClient keeps its
            // backoff path and cached data stays visible rather than locking.
            throw error
        }
    }

    /// A valid access token if one can be produced **without showing UI**, else nil.
    ///
    /// Tier 1 (cache) then tier 2 (silent refresh) only — tier 3 is never
    /// reached. Background and inactive-pairing work (polling an inactive
    /// desktop's online status) uses this: those paths run without the user
    /// having asked for anything, and throwing a browser sign-in sheet at them
    /// is the exact behaviour the post-cancel cooldown exists to prevent. A nil
    /// return means "no silent credential available", and the caller degrades.
    func accessTokenIfAvailable() async -> String? {
        if let token = cachedToken, let expiry = cachedExpiry,
           expiry.timeIntervalSinceNow > Self.expiryLeadSeconds {
            DiagnosticLog.log("oidc: silent request served from cache", tag: "oidc.token", fields: [
                "device": String(deviceId.prefix(8)),
                "expires_in_s": String(Int(expiry.timeIntervalSinceNow))
            ])
            return token
        }

        guard let refreshToken = KeychainHelper.get(keychainKey) else {
            DiagnosticLog.log("oidc: no silent credential available (no refresh token)", tag: "oidc.token", fields: [
                "device": String(deviceId.prefix(8))
            ])
            return nil
        }

        do {
            let endpoints = try await discoverEndpoints()
            let result = try await silentRefresh(refreshToken: refreshToken, tokenEndpoint: endpoints.tokenEndpoint)
            cachedToken = result.accessToken
            cachedExpiry = result.expiry
            DiagnosticLog.log("oidc: silent request refreshed token", tag: "oidc.token", fields: [
                "device": String(deviceId.prefix(8)),
                "expires_in_s": String(Int(result.expiry.timeIntervalSinceNow))
            ])
            return result.accessToken
        } catch {
            // Not escalated to interactive by design; the caller asked for a
            // silent token and gets nothing rather than a sign-in sheet.
            DiagnosticLog.log("oidc: silent request failed, not escalating", tag: "oidc.token", level: .warn, fields: [
                "device": String(deviceId.prefix(8)),
                "error": error.localizedDescription
            ])
            return nil
        }
    }

    /// Discard all credential state for this pairing and sign in interactively.
    ///
    /// Backs the user-initiated "Switch Account" action, which is the only way
    /// out of a relay subject mismatch: the relay bound this channel to a
    /// different identity, and no amount of refreshing changes which account the
    /// stored refresh token represents. The Keychain token is deleted and the
    /// post-cancel cooldown is cleared, because the user just explicitly asked
    /// for the sheet the cooldown normally suppresses.
    func forceInteractiveReauth() async throws -> String {
        DiagnosticLog.log("oidc: forced interactive re-auth requested", tag: "oidc.token", level: .warn, fields: [
            "device": String(deviceId.prefix(8)),
            "issuer": issuer
        ])
        cachedToken = nil
        cachedExpiry = nil
        accountIdentity = nil
        KeychainHelper.delete(keychainKey)
        interactiveCooldownUntil = .distantPast

        let endpoints = try await discoverEndpoints()
        do {
            let result = try await interactiveSignIn(
                authEndpoint: endpoints.authorizationEndpoint,
                tokenEndpoint: endpoints.tokenEndpoint
            )
            cachedToken = result.accessToken
            cachedExpiry = result.expiry
            DiagnosticLog.log("oidc: forced re-auth succeeded", tag: "oidc.token", fields: [
                "device": String(deviceId.prefix(8)),
                "expires_in_s": String(Int(result.expiry.timeIntervalSinceNow))
            ])
            return result.accessToken
        } catch OIDCTokenError.interactiveCancelled {
            // The user opened the picker and backed out. Re-arm the cooldown so
            // an automatic reconnect does not immediately re-present the sheet.
            interactiveCooldownUntil = Date().addingTimeInterval(Self.interactiveCancelCooldownSeconds)
            DiagnosticLog.log("oidc: forced re-auth cancelled by user", tag: "oidc.token", level: .warn, fields: [
                "device": String(deviceId.prefix(8)),
                "cooldown_s": String(Int(Self.interactiveCancelCooldownSeconds))
            ])
            throw OIDCTokenError.interactiveCancelled
        }
    }

    /// The account behind the current tokens, when one has been parsed.
    func currentIdentity() -> OIDCAccountIdentity? {
        accountIdentity
    }

    /// Invalidates the in-memory cached token. Called by RelayClient on 4401.
    /// The next accessToken() call will attempt silent refresh before falling
    /// back to interactive.
    func invalidateAccessToken() {
        DiagnosticLog.log("oidc: access token invalidated (4401 received)", tag: "oidc.token", fields: [
            "device": String(deviceId.prefix(8))
        ])
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
            // 400/401 indicate a rejected OAuth grant. 5xx is the provider
            // failing, not proof the locally stored grant is invalid.
            if http.statusCode == 400 || http.statusCode == 401 {
                throw OIDCTokenError.refreshGrantRejected("HTTP \(http.statusCode): \(body.prefix(200))")
            }
            throw OIDCTokenError.tokenEndpointFailed("HTTP \(http.statusCode): \(body.prefix(200))")
        }
        return try parseTokenResponse(data: data)
    }

    // MARK: - Token Response Parsing

    /// Parse a token-endpoint response, persist the rotated refresh token, and
    /// capture the account identity when the response carries an `id_token`.
    ///
    /// Actor-isolated so identity recording completes before a caller can observe
    /// a successful token result; no detached task can lose the update during a
    /// manager replacement.
    func parseTokenResponse(data: Data) throws -> OIDCTokenResult {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let accessToken = json["access_token"] as? String,
              let refreshToken = json["refresh_token"] as? String else {
            throw OIDCTokenError.missingTokenInResponse
        }
        let expiresIn = (json["expires_in"] as? TimeInterval) ?? 3600
        let expiry = Date().addingTimeInterval(expiresIn)
        // Persist refresh token (also called from silentRefresh to rotate)
        KeychainHelper.set(refreshToken, service: Self.refreshKey(deviceId: deviceId))

        // Capture the signing-in account for display. The scope always requests
        // `openid`, so Entra returns an id_token; an issuer that omits one just
        // leaves the pairing without an account label.
        if let idToken = json["id_token"] as? String,
           let identity = OIDCAccountIdentity.parse(idToken: idToken) {
            DiagnosticLog.log("oidc: captured account identity", tag: "oidc.token", fields: [
                "device": String(deviceId.prefix(8)),
                "has_username": String(!identity.username.isEmpty),
                "has_tenant": String(!identity.tenantId.isEmpty)
            ])
            onIdentity?(deviceId, identity)
            accountIdentity = identity
        } else {
            DiagnosticLog.log("oidc: token response carried no usable id_token", tag: "oidc.token", fields: [
                "device": String(deviceId.prefix(8)),
                "had_id_token": String(json["id_token"] != nil)
            ])
        }

        return OIDCTokenResult(accessToken: accessToken, refreshToken: refreshToken, expiry: expiry)
    }

}

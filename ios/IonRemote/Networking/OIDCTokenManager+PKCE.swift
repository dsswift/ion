import Foundation
import CryptoKit
import AuthenticationServices
import UIKit

// MARK: - Interactive PKCE

// Extracted from OIDCTokenManager.swift to keep that file under the 600-line
// cap once per-pairing identity capture, the silent-only accessor, and the
// forced re-auth path were added. This file owns tier 3 of the token ladder:
// the user-facing authorization-code + PKCE flow and the window anchor it
// needs. Tiers 1 and 2 (cache, silent refresh) stay in the base file.

extension OIDCTokenManager {

    /// Injectable secure-random byte source. Internal for XCTest so a random
    /// source failure can be pinned without weakening production generation.
    nonisolated static func secureRandomBytes(count: Int) throws -> [UInt8] {
        var bytes = [UInt8](repeating: 0, count: count)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else { throw OIDCTokenError.randomGenerationFailed }
        return bytes
    }

    nonisolated static func makeCodeVerifier(randomBytes: (Int) throws -> [UInt8]) throws -> String {
        let bytes = try randomBytes(32)
        guard bytes.count == 32 else { throw OIDCTokenError.randomGenerationFailed }
        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    nonisolated static func validateCallbackState(_ callbackState: String?, expected: String) throws {
        guard let callbackState else { throw OIDCTokenError.tokenEndpointFailed("no state in callback URL") }
        guard callbackState == expected else { throw OIDCTokenError.callbackStateMismatch }
    }

    @MainActor
    func interactiveSignIn(authEndpoint: URL, tokenEndpoint: URL) async throws -> OIDCTokenResult {
        // Generate PKCE code verifier (43 random URL-safe base64 chars)
        let codeVerifier = try Self.makeCodeVerifier(randomBytes: Self.secureRandomBytes)

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
            //
            // This matters most on a phone paired with desktops in DIFFERENT
            // tenants: the account Safari defaults to is right for at most one
            // of them, so the picker is the normal case, not the exception.
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

        // Extract authorization code only for THIS request's callback. Accepting
        // a code with another request's state defeats OAuth's CSRF binding.
        guard let callbackComponents = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false),
              callbackComponents.queryItems?.first(where: { $0.name == "state" })?.value == state,
              let code = callbackComponents.queryItems?.first(where: { $0.name == "code" })?.value else {
            if let callbackComponents = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false),
               callbackComponents.queryItems?.contains(where: { $0.name == "state" }) == true {
                throw OIDCTokenError.callbackStateMismatch
            }
            throw OIDCTokenError.tokenEndpointFailed("no code or state in callback URL")
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
        let result = try await self.parseTokenResponse(data: data)
        // parseTokenResponse already persisted the refresh token to Keychain
        // (it is the single persistence point, shared with silentRefresh's
        // rotation). No second write here.
        return result
    }
}

// MARK: - ASWebAuthentication Presentation Context

/// Singleton presentation context for ASWebAuthenticationSession.
/// Provides the key window as the anchor for the authentication web view.
final class ASWebAuthenticationPresentationContext: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = ASWebAuthenticationPresentationContext()

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first(where: { $0.isKeyWindow }) ?? ASPresentationAnchor()
    }
}
